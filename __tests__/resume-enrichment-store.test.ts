// enrichResumedSessionAsync used to write every resolved field onto the
// throwaway response copy SessionStore.get() returns, so all of it was silently
// discarded. These tests assert against the STORE (getManaged) rather than
// against a returned response — a test written the obvious way passes against
// the same throwaway the bug is about.
//
// The second half locks the type mismatch that made the naive fix worse: the
// store holds Dates, the response holds ISO strings, and writing a string into
// ManagedSession.firstMessageAt makes managedToResponse throw on .toISOString().

import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import type { ManagedSession } from "../src/types";

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

const API_KEY = "tb_test_resume_enrich";
const SESSION_ID = "cccccccc-1111-2222-3333-555555555555";
const FIRST_AT = "2026-07-01T10:00:00.000Z";
const LAST_AT = "2026-07-02T11:30:00.000Z";

interface Internals {
  sessionStore: {
    addManaged(s: ManagedSession): void;
    getManaged(id: string): ManagedSession | null;
  };
  cache: { getMetaById(id: string): unknown } | null;
  sessionVerdicts: Map<string, { sessionId: string; lifecycle: string; reason: string }>;
  enrichResumedSessionAsync(sessionId: string, projectPath: string, conv: unknown): void;
}

describe("enrichResumedSessionAsync — writes land in the store", () => {
  let configDir: string;
  let projectDir: string;
  let cacheDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "tb-enrich-cfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "tb-enrich-proj-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-enrich-cache-"));
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
      browseRoot: projectDir,
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);
    return { server, port, internals: server as unknown as Internals };
  }

  function seedSession(internals: Internals, over: Partial<ManagedSession> = {}): void {
    internals.sessionStore.addManaged({
      id: SESSION_ID,
      projectPath: projectDir,
      projectName: "proj",
      branch: "main",
      status: "running",
      startedAt: new Date("2026-07-02T12:00:00.000Z"),
      completedAt: null,
      promptCount: 0,
      lastOutput: "",
      ...over,
    });
  }

  function get(port: number, id = SESSION_ID) {
    return fetch(`http://localhost:${port}/api/sessions/${id}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  }

  it("persists sessionName and projectId onto the stored session", async () => {
    const { server, port, internals } = await makeServer();
    try {
      seedSession(internals);
      if (internals.cache) {
        vi.spyOn(internals.cache, "getMetaById").mockReturnValue({
          model: "opus",
          preview: "a preview",
          projectId: "proj-cached",
          firstMessage: JSON.stringify({ text: "first", timestamp: FIRST_AT }),
          lastMessage: JSON.stringify({ text: "last", timestamp: LAST_AT }),
        });
      }

      internals.enrichResumedSessionAsync(SESSION_ID, projectDir, {
        sessionName: "Fix the parser",
        messageCount: 7,
        account: "someone@example.com",
        filePath: "/tmp/conv.jsonl",
      });

      const stored = internals.sessionStore.getManaged(SESSION_ID);
      expect(stored?.sessionName).toBe("Fix the parser");
      expect(stored?.projectId).toBe("proj-cached");
      expect(stored?.messageCount).toBe(7);
      expect(stored?.account).toBe("someone@example.com");
      expect(stored?.resumedFromConversationId).toBe(SESSION_ID);

      // The store keeps Dates; the response serializes them. Writing ISO
      // strings here is what turned the silent no-op into a throw.
      expect(stored?.firstMessageAt).toBeInstanceOf(Date);
      expect(stored?.lastMessageAt).toBeInstanceOf(Date);

      const res = await get(port);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.firstMessageAt).toBe(FIRST_AT);
      expect(body.lastMessageAt).toBe(LAST_AT);
      expect(body.sessionName).toBe("Fix the parser");
    } finally {
      await server.close();
    }
  }, 30_000);

  it("drops an unparseable cached timestamp instead of storing an Invalid Date", async () => {
    const { server, port, internals } = await makeServer();
    try {
      seedSession(internals);
      if (internals.cache) {
        vi.spyOn(internals.cache, "getMetaById").mockReturnValue({
          firstMessage: JSON.stringify({ text: "first", timestamp: "not-a-date" }),
          lastMessage: null,
        });
      }

      internals.enrichResumedSessionAsync(SESSION_ID, projectDir, null);

      expect(internals.sessionStore.getManaged(SESSION_ID)?.firstMessageAt).toBeUndefined();
      const res = await get(port);
      expect(res.status).toBe(200);
      expect((await res.json()).firstMessageAt).toBeUndefined();
    } finally {
      await server.close();
    }
  }, 30_000);

  // Guards the handleGetSession refactor: it decorates a response copy by
  // building a new object, and both decorations must still reach the wire.
  it("still reports failureReason for a missing project dir and the reconciled lifecycle", async () => {
    const { server, port, internals } = await makeServer();
    try {
      const missing = join(projectDir, "gone");
      seedSession(internals, { projectPath: missing });
      internals.sessionVerdicts.set(SESSION_ID, {
        sessionId: SESSION_ID,
        lifecycle: "orphaned",
        reason: "test",
      });

      const res = await get(port);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.failureReason).toBe(`Project directory not found: ${missing}`);
      expect(body.lifecycle).toBe("orphaned");
      expect(body.lifecycleSource).toBe("reconcile");
    } finally {
      await server.close();
    }
  }, 30_000);
});
