// Sessions with more than one directory: `additionalPaths` on start and
// resume, validated against the browse root and spawned as `--add-dir`.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { spawn as mockSpawn } from "node-pty";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  function makeMockProcess() {
    const ee = new EventEmitter();
    // A prompt marker so the runner settles ready instead of waiting out its timer.
    setImmediate(() => ee.emit("data", "╭\n"));
    return {
      pid: 99999,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      exit: (exitCode: number) => ee.emit("exit", { exitCode }),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const API_KEY = "tb_test_multi_directory";
const UUID = "cccccccc-1111-2222-3333-444444444444";

function lastSpawnArgs(): string[] {
  const calls = (mockSpawn as any).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

function lastSpawnedProcess(): { exit: (code: number) => void } {
  const results = (mockSpawn as any).mock.results;
  return results[results.length - 1].value;
}

describe("sessions with additional directories", () => {
  let browseRoot: string;
  let configDir: string;
  let cacheDir: string;
  let server: any;
  let port: number;

  beforeEach(async () => {
    (mockSpawn as any).mockClear();
    browseRoot = realpathSync(mkdtempSync(join(tmpdir(), "tb-multidir-root-")));
    mkdirSync(join(browseRoot, "app"));
    mkdirSync(join(browseRoot, "lib"));
    mkdirSync(join(browseRoot, "docs"));
    configDir = mkdtempSync(join(tmpdir(), "tb-multidir-cfg-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-multidir-cache-"));

    const projectDir = join(browseRoot, "app");
    const jsonlDir = join(configDir, "projects", projectDir.replace(/[/\\:.]/g, "-"));
    mkdirSync(jsonlDir, { recursive: true });
    writeFileSync(
      join(jsonlDir, `${UUID}.jsonl`),
      `${JSON.stringify({ sessionId: UUID, cwd: projectDir, type: "user", message: "hi" })}\n`,
    );

    const { StreamerServer } = await import("../src/server");
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      browseRoot,
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      scannerPersistent: false,
      codexRoots: [],
      cursorRoots: [],
    });
    await server.listen(0);
    port = server.port;
  });

  afterEach(async () => {
    await server.close();
    for (const d of [browseRoot, configDir, cacheDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function post(path: string, body: Record<string, unknown>) {
    return fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
  }

  describe("POST /api/sessions/start", () => {
    it("spawns Claude with the resolved extra directories and reports them", async () => {
      const res = await post("/api/sessions/start", {
        path: "app",
        additionalPaths: ["lib", "docs/", "app", "lib"],
      });

      expect([200, 202]).toContain(res.status);
      const started = await res.json();
      const id: string = started.session?.id ?? started.id;
      const args = lastSpawnArgs();
      const at = args.indexOf("--add-dir");
      expect(args.slice(at, at + 3)).toEqual([
        "--add-dir",
        join(browseRoot, "lib"),
        join(browseRoot, "docs"),
      ]);

      const live = await fetch(`http://localhost:${port}/api/sessions/${id}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      }).then((r) => r.json());
      expect(live.additionalPaths).toEqual([join(browseRoot, "lib"), join(browseRoot, "docs")]);
    });

    it("refuses a provider without the capability before spawning", async () => {
      const res = await post("/api/sessions/start", {
        path: "app",
        provider: "cursor",
        additionalPaths: ["lib"],
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("MULTI_DIRECTORY_UNSUPPORTED");
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("lets a provider without the capability start with an empty list", async () => {
      const res = await post("/api/sessions/start", {
        path: "app",
        provider: "cursor",
        additionalPaths: [],
      });

      expect(res.status).not.toBe(400);
    });

    it.each([
      ["outside the browse root", ["../"]],
      ["missing", ["gone"]],
      ["not an array", "lib"],
      ["over the cap", Array.from({ length: 9 }, () => "lib")],
    ])("rejects an entry that is %s", async (_label, additionalPaths) => {
      const res = await post("/api/sessions/start", { path: "app", additionalPaths });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("INVALID_ADDITIONAL_PATHS");
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/sessions/resume", () => {
    it("takes an explicit list, then replays it when the next resume names none", async () => {
      const first = await post("/api/sessions/resume", {
        sessionId: UUID,
        force: true,
        additionalPaths: ["lib"],
      });
      expect(first.status).toBe(201);
      expect(lastSpawnArgs()).toEqual(
        expect.arrayContaining(["--add-dir", join(browseRoot, "lib")]),
      );

      lastSpawnedProcess().exit(0);
      await new Promise((r) => setTimeout(r, 50));

      const second = await post("/api/sessions/resume", { sessionId: UUID, force: true });
      expect(second.status).toBe(201);
      expect(lastSpawnArgs()).toEqual(
        expect.arrayContaining(["--add-dir", join(browseRoot, "lib")]),
      );
    });

    it("drops a recorded directory that no longer exists instead of failing", async () => {
      await post("/api/sessions/resume", {
        sessionId: UUID,
        force: true,
        additionalPaths: ["lib", "docs"],
      });
      lastSpawnedProcess().exit(0);
      await new Promise((r) => setTimeout(r, 50));
      rmSync(join(browseRoot, "docs"), { recursive: true });

      const res = await post("/api/sessions/resume", { sessionId: UUID, force: true });

      expect(res.status).toBe(201);
      const args = lastSpawnArgs();
      expect(args).toEqual(expect.arrayContaining(["--add-dir", join(browseRoot, "lib")]));
      expect(args).not.toContain(join(browseRoot, "docs"));
    });

    it("lets an explicit empty list clear the recorded directories", async () => {
      await post("/api/sessions/resume", {
        sessionId: UUID,
        force: true,
        additionalPaths: ["lib"],
      });
      lastSpawnedProcess().exit(0);
      await new Promise((r) => setTimeout(r, 50));

      const res = await post("/api/sessions/resume", {
        sessionId: UUID,
        force: true,
        additionalPaths: [],
      });

      expect(res.status).toBe(201);
      expect(lastSpawnArgs()).not.toContain("--add-dir");
    });

    it("answers 400 for an invalid list without spawning", async () => {
      const res = await post("/api/sessions/resume", {
        sessionId: UUID,
        force: true,
        additionalPaths: ["../"],
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("INVALID_ADDITIONAL_PATHS");
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
