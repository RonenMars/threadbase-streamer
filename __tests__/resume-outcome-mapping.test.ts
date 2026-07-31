// The status-code mapping `handleResume` newly owns after resumeSession() was
// extracted (plan Phase 7c prerequisite).
//
// The extraction turned three early `json(res, …)` returns into a discriminated
// union that a thin wrapper maps back to status codes. That mapping is the only
// genuinely new logic in the refactor, so it is what is pinned here. The
// collision path (409, then 201 with force) is covered end-to-end by
// resume-busy.test.ts, which passes unmodified.

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  return {
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("data", "╭\n"));
      return {
        pid: 4242,
        onData: (cb: (d: string) => void) => ee.on("data", cb),
        onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
        write: vi.fn(),
        kill: vi.fn(),
      };
    }),
  };
});

const API_KEY = "tb_test_resume_outcome";
const UNKNOWN_ID = "dddddddd-1111-4222-8333-999999999999";

async function makeServer() {
  const { StreamerServer } = await import("../src/server");
  const server = new StreamerServer({
    port: 0,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir: mkdtempSync(join(tmpdir(), "tb-resume-outcome-cache-")),
    scanProfiles: [],
    codexRoots: [],
  });
  await server.listen(0, { awaitReady: true });
  return server;
}

function resume(port: number, body: Record<string, unknown>) {
  return fetch(`http://localhost:${port}/api/sessions/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/sessions/resume — outcome mapping", () => {
  it("400s a request with no session id, without reaching resumeSession", async () => {
    const server = await makeServer();
    try {
      const res = await resume(server.port, {});
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Missing sessionId/);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("404s history_file_missing when nothing resolves for the id", async () => {
    // Permanent, not retryable: a generic 404 sends mobile into a retry loop,
    // which is why this reason is distinct from "path unknown".
    const server = await makeServer();
    try {
      const res = await resume(server.port, { sessionId: UNKNOWN_ID });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("history_file_missing");
    } finally {
      await server.close();
    }
  }, 30_000);

  it("accepts conversationId as the legacy alias for sessionId", async () => {
    // Same mapping, reached through the other body key — mobile still sends it.
    const server = await makeServer();
    try {
      const res = await resume(server.port, { conversationId: UNKNOWN_ID });
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  }, 30_000);
});
