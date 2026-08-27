import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamerServer } from "../src/server";
import type { PromptRegistry } from "../src/services/prompts/promptRegistry";
import type { AskQuestion, ManagedSession } from "../src/types";

/**
 * The PTY exit path, on a real StreamerServer: the real wiring closure
 * (createLiveSessionOptions' onStatusChange, as LiveSessionManager holds it),
 * the real private cancelPendingQuestion, the real registry and pending maps.
 * A stub of any of those would test the mirror rather than the guard, and the
 * guard here is which of them runs when no JSONL file was ever mapped.
 */

const API_KEY = "tb_test_prompt_exit_clear";
const SESSION = "exit-clear-session";
const QUESTIONS: AskQuestion[] = [
  {
    question: "Which language?",
    header: "Language",
    multiSelect: false,
    options: [
      { label: "TypeScript", description: "Typed JavaScript" },
      { label: "Rust", description: "Systems language" },
    ],
  },
];

type Internals = {
  ptyManager: { options: { onStatusChange: (session: ManagedSession) => void } };
  sessionHandlers: {
    handleLiveQuestion: (
      sessionId: string,
      questions: AskQuestion[],
      occurrenceId?: string,
    ) => void;
    handleJsonlQuestion: (
      sessionId: string,
      toolUseId: string,
      questions: AskQuestion[],
      origin: "pty" | "jsonl",
    ) => void;
  };
  promptRegistry: PromptRegistry;
  pendingQuestions: Map<string, { promptId: string; toolUseId: string }>;
  pendingQuestionKey: Map<string, string>;
  sessionFileMap: Map<string, string>;
};

function idleSession(): ManagedSession {
  return { id: SESSION, status: "idle" } as ManagedSession;
}

describe("pty exit clears a pending question with no JSONL mapping", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let internals: Internals;

  beforeEach(async () => {
    const { StreamerServer } = await import("../src/server");
    cacheDir = mkdtempSync(join(tmpdir(), "tb-prompt-exit-"));
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
  });

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("cancels the prompt and clears both maps when no file was mapped", () => {
    internals.sessionHandlers.handleLiveQuestion(SESSION, QUESTIONS);
    const promptId = internals.pendingQuestions.get(SESSION)?.promptId ?? "";
    expect(internals.promptRegistry.get(promptId)?.state).toBe("open");
    expect(internals.sessionFileMap.has(SESSION)).toBe(false);

    internals.ptyManager.options.onStatusChange(idleSession());

    expect(internals.pendingQuestions.has(SESSION)).toBe(false);
    expect(internals.pendingQuestionKey.has(SESSION)).toBe(false);
    // Cancelled by the question path, not swept up as `unavailable` by
    // invalidateSession — the clear has to land first.
    expect(internals.promptRegistry.get(promptId)).toMatchObject({
      state: "cancelled",
      terminalReason: "provider_closed",
    });

    // The JSONL flush of that same question arrives after the exit. With the
    // pending entry still in place it reaches update() on a terminal prompt.
    expect(() =>
      internals.sessionHandlers.handleJsonlQuestion(SESSION, "toolu_late", QUESTIONS, "jsonl"),
    ).not.toThrow();
    const reopened = internals.pendingQuestions.get(SESSION)?.promptId ?? "";
    expect(reopened).not.toBe(promptId);
    expect(internals.promptRegistry.get(reopened)?.state).toBe("open");
  });

  it("still cancels the mapped-file case", () => {
    internals.sessionHandlers.handleLiveQuestion(SESSION, QUESTIONS);
    const promptId = internals.pendingQuestions.get(SESSION)?.promptId ?? "";
    internals.sessionFileMap.set(SESSION, join(cacheDir, `${SESSION}.jsonl`));

    internals.ptyManager.options.onStatusChange(idleSession());

    expect(internals.pendingQuestions.has(SESSION)).toBe(false);
    expect(internals.pendingQuestionKey.has(SESSION)).toBe(false);
    expect(internals.promptRegistry.get(promptId)?.state).toBe("cancelled");
    expect(internals.sessionFileMap.has(SESSION)).toBe(false);
  });
});
