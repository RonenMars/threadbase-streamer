import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamerServer } from "../src/server";
import type { ManagedSession } from "../src/types";

/**
 * A live session's `messageCount` used to be a one-shot copy taken at resume,
 * absent for a fresh start and frozen as the chat grew. The end-of-turn refresh
 * already learns the fresh total; these tests pin that it reaches the store and
 * the `session_update` frame. Real StreamerServer and real onStatusChange
 * closure, with only the scanner's answer stubbed.
 */

const API_KEY = "tb_test_live_message_count";
const SESSION = "live-count-session";

type Internals = {
  ptyManager: { options: { onStatusChange: (session: ManagedSession) => void } };
  sessionStore: {
    addManaged(s: ManagedSession): void;
    getManaged(id: string): ManagedSession | null;
    updateManaged(id: string, updates: Partial<ManagedSession>): ManagedSession | null;
  };
  sessionFileMap: Map<string, string>;
  scannerManager: {
    get: () => Promise<unknown>;
    refreshFileAfterWrite: () => Promise<{
      outcome: string;
      meta: { messageCount: number } | null;
    }>;
  };
  wsHub: { broadcast: (message: { type: string; session?: { messageCount?: number } }) => void };
};

function session(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: SESSION,
    projectPath: "/tmp/proj",
    projectName: "proj",
    branch: "main",
    status: "waiting_input",
    startedAt: new Date("2026-07-02T12:00:00.000Z"),
    completedAt: null,
    promptCount: 1,
    lastOutput: "",
    ...over,
  } as ManagedSession;
}

describe("end-of-turn refresh keeps a live session's messageCount current", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let internals: Internals;
  let frames: Array<{ type: string; session?: { messageCount?: number } }>;

  beforeEach(async () => {
    const { StreamerServer } = await import("../src/server");
    cacheDir = mkdtempSync(join(tmpdir(), "tb-live-count-"));
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(0);
    internals = server as unknown as Internals;
    internals.sessionStore.addManaged(session());
    internals.sessionFileMap.set(SESSION, join(cacheDir, `${SESSION}.jsonl`));
    internals.scannerManager.get = async () => ({});
    frames = [];
    internals.wsHub.broadcast = (message) => {
      frames.push(message);
    };
  });

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  function scannerReports(meta: { messageCount: number } | null): void {
    internals.scannerManager.refreshFileAfterWrite = async () => ({ outcome: "refreshed", meta });
  }

  it("stores the fresh total and broadcasts it, for a session that never had one", async () => {
    scannerReports({ messageCount: 7 });
    expect(internals.sessionStore.getManaged(SESSION)?.messageCount).toBeUndefined();

    internals.ptyManager.options.onStatusChange(session());

    await vi.waitFor(() => {
      expect(internals.sessionStore.getManaged(SESSION)?.messageCount).toBe(7);
    });
    const withCount = frames.filter(
      (f) => f.type === "session_update" && f.session?.messageCount === 7,
    );
    expect(withCount).toHaveLength(1);
  });

  it("replaces a stale resume-time snapshot as the chat grows", async () => {
    internals.sessionStore.updateManaged(SESSION, { messageCount: 3 });
    scannerReports({ messageCount: 9 });

    internals.ptyManager.options.onStatusChange(session());

    await vi.waitFor(() => {
      expect(internals.sessionStore.getManaged(SESSION)?.messageCount).toBe(9);
    });
  });

  it("does not rebroadcast when the total has not moved", async () => {
    internals.sessionStore.updateManaged(SESSION, { messageCount: 4 });
    scannerReports({ messageCount: 4 });

    internals.ptyManager.options.onStatusChange(session());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      frames.filter((f) => f.session?.messageCount === 4 && f.type === "session_update"),
    ).toHaveLength(1);
  });

  it("leaves the stored count alone when the file no longer parses", async () => {
    internals.sessionStore.updateManaged(SESSION, { messageCount: 5 });
    scannerReports(null);

    internals.ptyManager.options.onStatusChange(session());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(internals.sessionStore.getManaged(SESSION)?.messageCount).toBe(5);
  });
});
