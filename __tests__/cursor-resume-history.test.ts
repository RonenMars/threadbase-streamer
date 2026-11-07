import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawn } from "node-pty";
import { tmpdir } from "os";
import { join } from "path";
import { cursorAgentTranscriptsDir } from "../src/cursor-transcript-watch";
import type { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { StreamerServer } from "../src/server";
import type { SessionStore } from "../src/session-store";
import type { ManagedSession } from "../src/types";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const events = new EventEmitter();
    return {
      pid: 99999,
      onData: (cb: (data: string) => void) => events.on("data", cb),
      onExit: (cb: (event: { exitCode: number }) => void) => events.on("exit", cb),
      write: vi.fn(),
      resize: vi.fn(),
      kill: () => events.emit("exit", { exitCode: 0 }),
    };
  }),
}));

const SESSION_ID = "b1b1b1b1-0000-4000-8000-000000000001";
const TRANSCRIPT_ID = "c1c1c1c1-0000-4000-8000-000000000001";
const API_KEY = "tb_test_cursor_resume_history";

describe("Cursor resume history", () => {
  // An "unbound" row is one whose binding write failed: only the live session has the id.
  it.each(["bound", "unbound", "absent"])("preserves history when the row is %s", async (row) => {
    const dir = mkdtempSync(join(tmpdir(), "tb-cursor-resume-history-"));
    const projectPath = join(dir, "project");
    const cursorRoot = join(dir, "cursor");
    const transcriptDir = join(cursorAgentTranscriptsDir(cursorRoot, projectPath), TRANSCRIPT_ID);
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, `${TRANSCRIPT_ID}.jsonl`),
      `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "saved prompt" }] } })}\n`,
    );
    const server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      disableDb: true,
      cacheDir: join(dir, "cache"),
      runtimeDbPath: join(dir, "runtime.db"),
      browseRoot: projectPath,
      scanProfiles: [],
      codexRoots: [],
      cursorRoots: [cursorRoot],
      scannerPersistent: false,
    });
    try {
      await server.listen(0, { awaitReady: true });
      const internals = server as unknown as {
        sessionStore: SessionStore;
        managedSessionsRepo: ManagedSessionsRepository | null;
      };
      const session: ManagedSession = {
        id: SESSION_ID,
        provider: "cursor",
        projectPath,
        projectName: "project",
        branch: "main",
        status: "idle",
        startedAt: new Date(),
        completedAt: new Date(),
        promptCount: 1,
        lastOutput: "",
        boundConversationId: TRANSCRIPT_ID,
      };
      internals.sessionStore.addManaged(session);
      if (row !== "absent") {
        expect(internals.managedSessionsRepo).not.toBeNull();
        internals.managedSessionsRepo?.recordSpawn({
          session: row === "bound" ? session : { ...session, boundConversationId: undefined },
          pid: 99999,
          cmdline: "agent",
          streamerInstanceId: "previous-run",
        });
      }
      vi.mocked(spawn).mockClear();
      const headers = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
      const response = await fetch(`http://localhost:${server.port}/api/sessions/resume`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId: SESSION_ID, force: true }),
      });
      expect(response.status).toBe(201);
      expect((await response.json()).boundConversationId).toBe(TRANSCRIPT_ID);
      expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toContain(`--resume=${TRANSCRIPT_ID}`);
      expect(internals.managedSessionsRepo?.get(SESSION_ID)?.bound_conversation_id).toBe(
        TRANSCRIPT_ID,
      );
      const history = await fetch(
        `http://localhost:${server.port}/api/conversations/${SESSION_ID}`,
        {
          headers,
        },
      );
      expect(history.status).toBe(200);
      expect((await history.json()).messages).toHaveLength(1);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
