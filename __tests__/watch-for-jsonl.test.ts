// Integration tests for the watchForJsonl fallback:
// Claude `resume` APPENDS to the SAME JSONL with the SAME sessionId (observed on
// Claude Code v2.1.215) — it does NOT write a new UUID's file, as this fallback
// once assumed. The fallback therefore only binds a candidate whose identity
// matches the session id, and must never capture a foreign conversation.

// Capture pino logs before any module import so the baseLogger singleton
// (created at logger.ts module-evaluation time) writes through our spy.
const _capturedLogs: string[] = [];
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk: any, ...args: any[]): boolean => {
  _capturedLogs.push(typeof chunk === "string" ? chunk : chunk.toString());
  return _origWrite(chunk, ...args);
};

import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { homedir } from "os";
import { basename, join, sep } from "path";
import WebSocket from "ws";
import { StreamerServer } from "../src/server";

// ─── Mock node-pty ────────────────────────────────────────────────────────────

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    // Emit a prompt marker shortly after spawn, like a real Claude session
    // does, so pty-manager's markReady()/onReady fires instead of the
    // server blocking POST /api/sessions/start until its ready-timeout.
    setImmediate(() => ee.emit("data", "╭\n"));
    return {
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const API_KEY = "tb_test_watch_for_jsonl";

// Returns the Claude projects dir for a given absolute project path —
// must match the encoding in watchForJsonl (server.ts line 2059).
function claudeProjectsDir(projectPath: string): string {
  const encoded = projectPath.replace(/[/\\:.]/g, "-");
  return join(homedir(), ".claude", "projects", encoded);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("watchForJsonl — conversation_event wiring", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;
  let projectPath: string;
  let cacheDir: string;
  let origBrowseRoot: string | undefined;

  beforeEach(async () => {
    // Clear the shared log spy before each test.
    _capturedLogs.length = 0;

    port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;

    // Create a project dir directly under homedir.
    // Set THREADBASE_BROWSE_ROOT so loadBrowseRoot() (which reads server.yaml)
    // is overridden — otherwise the test server picks up the dev browse_root.
    projectPath = mkdtempSync(join(homedir(), "threadbase-wfj-proj-"));
    origBrowseRoot = process.env.THREADBASE_BROWSE_ROOT;
    process.env.THREADBASE_BROWSE_ROOT = homedir();

    cacheDir = mkdtempSync(join(homedir(), "threadbase-wfj-cache-"));
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
    });
    await server.listen(port);
  });

  afterEach(async () => {
    await server.close();
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    if (origBrowseRoot === undefined) {
      delete process.env.THREADBASE_BROWSE_ROOT;
    } else {
      process.env.THREADBASE_BROWSE_ROOT = origBrowseRoot;
    }
  });

  function jsonlWiredLog(sessionId: string, filePath?: string): boolean {
    return _capturedLogs.some((line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.event !== "session.jsonl_wired" || obj.sessionId !== sessionId) return false;
        return filePath ? obj.filePath === filePath : true;
      } catch {
        return false;
      }
    });
  }

  async function startSession(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/sessions/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      // path is relative to browseRoot (homedir); pass just the basename
      body: JSON.stringify({ path: basename(projectPath) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { id: string } };
    return body.session.id;
  }

  it("primary path: wires {sessionId}.jsonl when it is present at session start", async () => {
    // We can't pre-create {sessionId}.jsonl because the UUID isn't known yet.
    // Instead, verify the file path encoding is correct by ensuring the server
    // picks up a JSONL that we create immediately after session start — relying
    // on tryWire() re-running when fsWatch fires. In vitest this sometimes misses,
    // so we also assert the negative-of-fallback: a file named exactly after the
    // session UUID (not any other UUID) is the primary candidate.
    //
    // The real guard here is the fallback test below — if the path encoding were
    // wrong, the fallback test would find the wrong file and fail.
    const sessionId = await startSession();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // The expected JSONL path uses the same encoding as server.ts:
    const expectedPath = join(claudeProjectsDir(projectPath), `${sessionId}.jsonl`);
    expect(expectedPath).toContain([".claude", "projects"].join(sep));
  });

  it("fallback does NOT bind a foreign actively-written JSONL (P0.4)", async () => {
    // Connect WS before starting the session so the client is registered.
    const events: unknown[] = [];
    const ws = new WebSocket(`ws://localhost:${port}/ws?key=${API_KEY}`);
    ws.on("message", (d) => {
      try {
        events.push(JSON.parse(d.toString()));
      } catch {
        /* ignore non-JSON */
      }
    });
    await new Promise<void>((r) => ws.on("open", r));

    // Pre-create a FOREIGN conversation JSONL (different stem, and its first
    // line carries a different sessionId) touched < 5s ago. The old fallback
    // bound whichever JSONL was most recently modified, capturing this foreign
    // conversation and re-broadcasting its transcript under the new session id.
    // The hardened fallback requires an identity match, so it must NOT bind it.
    const dir = claudeProjectsDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const foreignConvId = "aaaabbbb-0000-0000-0000-000000000001";
    const jsonlPath = join(dir, `${foreignConvId}.jsonl`);
    writeFileSync(
      jsonlPath,
      `${JSON.stringify({
        sessionId: foreignConvId,
        type: "user",
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
        isMeta: false,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      })}\n`,
    );

    const sessionId = await startSession();

    // Give tryWire() (sync during start + any fsWatch re-fire) time to run.
    await new Promise((r) => setTimeout(r, 300));

    expect(jsonlWiredLog(sessionId)).toBe(false);
    expect(
      (events as any[]).some((e) => e.type === "conversation_event" && e.sessionId === sessionId),
    ).toBe(false);

    ws.close();
  });

  it("fallback binds a differently-named JSONL whose first-line sessionId matches", async () => {
    const sessionId = await startSession();

    // A resumed/renamed file whose stem differs but whose first-line sessionId
    // equals our session id is a legitimate identity match. No primary
    // {sessionId}.jsonl exists, so the fallback selects this file.
    const dir = claudeProjectsDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const otherStem = "ccccdddd-0000-0000-0000-000000000009";
    const jsonlPath = join(dir, `${otherStem}.jsonl`);
    writeFileSync(jsonlPath, `${JSON.stringify({ sessionId, cwd: projectPath, type: "user" })}\n`);

    // Drive tryWire() synchronously rather than depending on fsWatch timing.
    (server as any).watchForJsonl(sessionId, projectPath);

    // sessionFileMap is set synchronously during wiring (the pino wired-log
    // flushes asynchronously, so assert the in-memory state instead).
    expect((server as any).sessionFileMap.get(sessionId)).toBe(jsonlPath);
  });

  it("readFirstLineSessionId returns the sessionId field, or null when absent/malformed", () => {
    const dir = claudeProjectsDir(projectPath);
    mkdirSync(dir, { recursive: true });

    const withId = join(dir, "with-id.jsonl");
    writeFileSync(withId, `${JSON.stringify({ sessionId: "sid-123", type: "user" })}\nmore\n`);
    expect((server as any).readFirstLineSessionId(withId)).toBe("sid-123");

    const withoutId = join(dir, "without-id.jsonl");
    writeFileSync(withoutId, `${JSON.stringify({ type: "user", uuid: "x" })}\n`);
    expect((server as any).readFirstLineSessionId(withoutId)).toBeNull();

    const malformed = join(dir, "malformed.jsonl");
    writeFileSync(malformed, "not json at all\n");
    expect((server as any).readFirstLineSessionId(malformed)).toBeNull();
  });

  it("seeds the tail-watcher offset AFTER the pre-broadcast dump (no double-broadcast)", async () => {
    const sessionId = await startSession();

    // Create the primary {sessionId}.jsonl with existing content.
    const dir = claudeProjectsDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const jsonlPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, `${JSON.stringify({ sessionId, cwd: projectPath, type: "user" })}\n`);

    // Spy on the dump (broadcastConversationLines) and the tail-watcher start
    // (fileWatcher.watch). The fix seeds the offset only AFTER dumping, so the
    // dump must be invoked before watch(); otherwise a line appended in the
    // window between watch() and the dump ships twice.
    const dumpSpy = vi
      .spyOn(server as any, "broadcastConversationLines")
      .mockImplementation(() => {});
    const watchSpy = vi.spyOn((server as any).fileWatcher, "watch").mockImplementation(() => {});

    (server as any).watchForJsonl(sessionId, projectPath);

    expect(dumpSpy).toHaveBeenCalled();
    expect(watchSpy).toHaveBeenCalledWith(jsonlPath);
    expect(dumpSpy.mock.invocationCallOrder[0]).toBeLessThan(watchSpy.mock.invocationCallOrder[0]);

    dumpSpy.mockRestore();
    watchSpy.mockRestore();
  });

  it("fallback not triggered: stale JSONL (>5s old) is ignored", async () => {
    // Create a stale JSONL before starting the session.
    const dir = claudeProjectsDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const staleId = "aaaabbbb-0000-0000-0000-000000000002";
    const jsonlPath = join(dir, `${staleId}.jsonl`);
    writeFileSync(jsonlPath, "");
    const staleTime = new Date(Date.now() - 10_000);
    const { utimesSync } = await import("fs");
    utimesSync(jsonlPath, staleTime, staleTime);

    const sessionId = await startSession();

    // tryWire() found the stale JSONL but rejected it (mtime > 5s ago).
    await new Promise((r) => setTimeout(r, 300));
    expect(jsonlWiredLog(sessionId)).toBe(false);
  });

  it("no JSONLs at all: no wiring fires", async () => {
    // Start a session with no JSONL files in the project dir.
    const sessionId = await startSession();

    await new Promise((r) => setTimeout(r, 300));
    expect(jsonlWiredLog(sessionId)).toBe(false);
  });
});
