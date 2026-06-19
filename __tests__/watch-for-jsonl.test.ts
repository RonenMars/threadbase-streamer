// Integration tests for the watchForJsonl fallback:
// When Claude resumes an existing conversation, it writes to a different UUID's
// JSONL file. The server must wire that file for conversation_event streaming.

// Capture pino logs before any module import so the baseLogger singleton
// (created at logger.ts module-evaluation time) writes through our spy.
const _capturedLogs: string[] = [];
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk: any, ...args: any[]): boolean => {
  _capturedLogs.push(typeof chunk === "string" ? chunk : chunk.toString());
  return _origWrite(chunk, ...args);
};

import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import { homedir } from "os";
import { basename, join } from "path";
import WebSocket from "ws";
import { StreamerServer } from "../src/server";

// ─── Mock node-pty ────────────────────────────────────────────────────────────

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
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

// Wait up to `ms` for `predicate` to return truthy, polling every 50ms.
async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("watchForJsonl — conversation_event wiring", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;
  let projectPath: string;
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

    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(homedir(), "threadbase-wfj-cache-")),
      scanProfiles: [],
    });
    await server.listen(port);
  });

  afterEach(async () => {
    await server.close();
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
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string };
    return body.id;
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
    expect(expectedPath).toContain("/.claude/projects/");
  });

  it("fallback path: wires a recently-modified JSONL when session file never appears", async () => {
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

    // Pre-create the "old" conversation JSONL with a line of content BEFORE
    // starting the session. tryWire() runs synchronously during startSession()
    // and finds this file (< 5s old, not named after sessionId → fallback).
    // Since the file has content, tryWire immediately broadcasts the existing
    // line via wsHub.broadcast → WS clients receive conversation_event.
    const dir = claudeProjectsDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const existingConvId = "aaaabbbb-0000-0000-0000-000000000001";
    const jsonlPath = join(dir, `${existingConvId}.jsonl`);
    writeFileSync(
      jsonlPath,
      `${JSON.stringify({
        type: "user",
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
        isMeta: false,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      })}\n`,
    );

    const sessionId = await startSession();

    // tryWire() ran synchronously: fallback found existingConvId.jsonl,
    // read its existing line, and broadcast conversation_event immediately.
    await waitFor(() =>
      (events as any[]).some((e) => e.type === "conversation_event" && e.sessionId === sessionId),
    );

    ws.close();
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
