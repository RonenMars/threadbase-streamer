// GET /api/sessions/:id enriches a LIVE session with the facts scraped from
// Claude's rendered status line (model / effort / permission mode), so mobile
// can render them natively instead of parsing terminal text.
//
// This covers the wiring (route → handler → parseStatusLine) that the parser's
// own unit tests can't: an async handler reached through the real Hono app.

import { createServer } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The mock PTY paints Claude's real footer, so the handler's getOutputLines()
// read returns something parseStatusLine can actually work on.
const FOOTER = [
  "\x1b[36mOpus 4.8 (1M context)\x1b[39m │ ~/x  main ✎ │ 26.5.0 23:41\r\n",
  "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents\r\n",
  "● high · /effort\r\n",
].join("");

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  function makeMockProcess() {
    const ee = new EventEmitter();
    setImmediate(() => {
      // Prompt marker first so the session reaches ready, then the footer.
      ee.emit("data", "╭\n");
      ee.emit("data", FOOTER);
    });
    return {
      pid: 99999,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const API_KEY = "tb_test_status_line";

describe("GET /api/sessions/:id — status-line enrichment", () => {
  let configDir: string;
  let projectDir: string;
  let cacheDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "tb-status-cfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "tb-status-proj-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-status-cache-"));
  });

  afterEach(() => {
    for (const d of [configDir, projectDir, cacheDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  async function makeServer() {
    const { StreamerServer } = await import("../src/server");
    const port = await getRandomPort();
    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      // The session's project dir is a tmpdir, which sits outside the default
      // browse root — point the root at it or /start rejects with 400.
      browseRoot: projectDir,
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);
    return { server, port };
  }

  it("reports model, effort and permission mode for a live session", async () => {
    const { server, port } = await makeServer();
    try {
      // Spawn through the server's own manager (mocked node-pty above) so the
      // session is genuinely live and its screen holds the rendered footer.
      // Going via POST /start would additionally depend on browse-root
      // resolution, which is async at startup and irrelevant to this behavior.
      const internals = server as unknown as {
        ptyManager: {
          startFresh(opts: {
            projectPath: string;
            prompt: string;
          }): Promise<{ id: string } & Record<string, unknown>>;
        };
        sessionStore: { addManaged(s: Record<string, unknown>): void };
      };
      const session = await internals.ptyManager.startFresh({
        projectPath: projectDir,
        prompt: "hi",
      });
      internals.sessionStore.addManaged(session);

      const res = await fetch(`http://localhost:${port}/api/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.effort).toBe("high");
      expect(body.permissionMode).toBe("accept edits on");
      expect(body.model).toBe("Opus 4.8 (1M context)");
    } finally {
      await server.close();
    }
  }, 30000);
});
