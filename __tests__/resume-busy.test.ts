// P0.1 — handleResume collision detection: a conversation whose JSONL was
// written within the busy window is refused with 409 CONVERSATION_BUSY unless
// the caller passes { force: true }.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  function makeMockProcess() {
    const ee = new EventEmitter();
    // Emit a prompt marker so pty-manager markReady() fires and start() resolves
    // quickly instead of blocking on the ready timeout.
    setImmediate(() => ee.emit("data", "╭\n"));
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

const API_KEY = "tb_test_resume_busy";
const UUID = "bbbbbbbb-1111-2222-3333-444444444444";

describe("handleResume — CONVERSATION_BUSY collision detection", () => {
  let configDir: string;
  let projectDir: string;
  let cacheDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "tb-resume-busy-cfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "tb-resume-busy-proj-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-resume-busy-cache-"));

    // <configDir>/projects/<encoded>/<uuid>.jsonl with a fresh mtime and a cwd
    // the resume path can read the project path from.
    const encoded = projectDir.replace(/[/\\:.]/g, "-");
    const jsonlDir = join(configDir, "projects", encoded);
    mkdirSync(jsonlDir, { recursive: true });
    writeFileSync(
      join(jsonlDir, `${UUID}.jsonl`),
      `${JSON.stringify({ sessionId: UUID, cwd: projectDir, type: "user", message: "hi" })}\n`,
    );
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
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);
    return { server, port };
  }

  function resume(port: number, body: Record<string, unknown>) {
    return fetch(`http://localhost:${port}/api/sessions/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
  }

  // Longer than the 15s default: the probe calls discoverClaudeProcesses() on
  // each resume, and the Windows WMI process query costs a few seconds a call.
  it("returns 409 CONVERSATION_BUSY for a recently-written conversation, then 201 with force", async () => {
    const { server, port } = await makeServer();
    try {
      const res409 = await resume(port, { sessionId: UUID });
      expect(res409.status).toBe(409);
      const body = (await res409.json()) as {
        code: string;
        detectedBy: string[];
        likelyOwner: string;
      };
      expect(body.code).toBe("CONVERSATION_BUSY");
      expect(body.detectedBy).toContain("jsonl_mtime");
      expect(["external", "unknown"]).toContain(body.likelyOwner);

      // force overrides the collision and spawns.
      const resForce = await resume(port, { sessionId: UUID, force: true });
      expect(resForce.status).toBe(201);
    } finally {
      await server.close();
    }
  }, 60_000);
});
