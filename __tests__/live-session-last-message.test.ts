import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamerServer } from "../src/server";
import type { ManagedSession } from "../src/types";

/**
 * A live session's `lastMessageText` used to be set once, when its JSONL was
 * linked, and never again. These tests drive transcript lines through the real
 * watcher callback and pin that the text and its role reach the store, the
 * response, and (once the turn has settled) a `session_update`.
 */

const SESSION = "live-last-message-session";

type Frame = { type: string; session?: { lastMessageText?: string; lastMessageRole?: string } };
type Internals = {
  sessionStore: {
    addManaged(s: ManagedSession): void;
    getManaged(id: string): ManagedSession | null;
  };
  sessionFileMap: Map<string, string>;
  fileWatcher: { onNewLines: (filePath: string, lines: string[]) => void };
  wsHub: { broadcast: (message: Frame) => void };
};

const assistant = (text: string, timestamp = "2026-11-13T10:00:05.000Z") =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const toolResult = JSON.stringify({
  type: "user",
  timestamp: "2026-11-13T10:00:06.000Z",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
});

describe("live session last message follows the transcript", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let internals: Internals;
  let filePath: string;
  let frames: Frame[];

  async function start(status: ManagedSession["status"]): Promise<void> {
    const { StreamerServer } = await import("../src/server");
    server = new StreamerServer({
      port: 0,
      apiKey: "tb_test_live_last_message",
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
    internals.sessionStore.addManaged({
      id: SESSION,
      projectPath: "/tmp/proj",
      projectName: "proj",
      branch: "main",
      status,
      startedAt: new Date("2026-11-13T10:00:00.000Z"),
      completedAt: null,
      promptCount: 1,
      lastOutput: "",
    } as ManagedSession);
    filePath = join(cacheDir, `${SESSION}.jsonl`);
    internals.sessionFileMap.set(SESSION, filePath);
    frames = [];
    internals.wsHub.broadcast = (message) => {
      frames.push(message);
    };
  }

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "tb-live-last-msg-"));
  });

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("stores the newest text line and its role, ignoring a later tool result", async () => {
    await start("running");

    internals.fileWatcher.onNewLines(filePath, [assistant("All tests pass."), toolResult]);

    const s = internals.sessionStore.getManaged(SESSION);
    expect(s?.lastMessageText).toBe("All tests pass.");
    expect(s?.lastMessageRole).toBe("assistant");
    expect(s?.lastMessageAt?.toISOString()).toBe("2026-11-13T10:00:05.000Z");
    // A running turn's own settle carries the value; no extra frame.
    expect(frames.filter((f) => f.type === "session_update")).toHaveLength(0);
  });

  it("pushes a reply that lands after the turn settled, once", async () => {
    await start("waiting_input");

    internals.fileWatcher.onNewLines(filePath, [assistant("Done: PR opened.")]);
    internals.fileWatcher.onNewLines(filePath, [toolResult]);
    internals.fileWatcher.onNewLines(filePath, [assistant("Done: PR opened.")]);

    const updates = frames.filter((f) => f.type === "session_update");
    expect(updates).toHaveLength(1);
    expect(updates[0].session).toMatchObject({
      lastMessageText: "Done: PR opened.",
      lastMessageRole: "assistant",
    });
  });
});
