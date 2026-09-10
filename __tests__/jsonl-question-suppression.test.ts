// P0.2 — JSONL-derived AskUserQuestion safety:
//   (a) suppressed entirely for a contended session (the line may be authored
//       by the other owner of a shared conversation), and
//   (b) never clobbers a live PTY-screen question that is a DIFFERENT question.
// Drives the extracted processJsonlQuestions() directly for determinism.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { StreamerServer } from "../src/server";
import type { AskQuestion } from "../src/types";

// A JSONL line carrying an AskUserQuestion tool_use, as Claude writes it.
function qLine(question: string, labels: string[], toolUseId: string): string {
  return JSON.stringify({
    message: {
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question,
                header: "H",
                options: labels.map((l) => ({ label: l, description: "" })),
              },
            ],
          },
        },
      ],
    },
  });
}

// The parsed AskQuestion[] equivalent, as the live-screen path supplies it.
function qParsed(question: string, labels: string[]): AskQuestion[] {
  return [
    {
      question,
      header: "H",
      multiSelect: false,
      options: labels.map((l) => ({ label: l, description: "" })),
    },
  ];
}

describe("processJsonlQuestions — P0.2 suppression + anti-clobber", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let broadcasts: Array<{ type: string; toolUseId?: string }>;

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    cacheDir = mkdtempSync(join(tmpdir(), "tb-jsonl-q-cache-"));
    server = new StreamerServer({
      port: 0,
      apiKey: "tb_test_jsonl_q",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(0);
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    broadcasts = [];
    // Prompt events are subscriber-scoped, so they leave through
    // broadcastToClients(clients, message); the message is the second arg.
    vi.spyOn((server as any).wsHub, "broadcastToClients").mockImplementation(
      (...args: unknown[]) => {
        broadcasts.push(args[1] as { type: string; toolUseId?: string });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) suppresses a JSONL question card when the session is contended", () => {
    const SID = "contended-sess";
    (server as any).contendedSessions.add(SID);

    (server as any).processJsonlQuestions(SID, [
      qLine("Deploy to prod?", ["yes", "no"], "toolu_ext"),
    ]);

    expect(broadcasts.some((b) => b.type === "question")).toBe(false);
    expect((server as any).pendingQuestions.has(SID)).toBe(false);
  });

  it("broadcasts and stores a JSONL question when the session is NOT contended", () => {
    const SID = "normal-sess";

    (server as any).processJsonlQuestions(SID, [qLine("Pick one", ["a", "b"], "toolu_norm")]);

    expect(broadcasts.some((b) => b.type === "question" && b.toolUseId === "toolu_norm")).toBe(
      true,
    );
    const pending = (server as any).pendingQuestions.get(SID);
    expect(pending?.toolUseId).toBe("toolu_norm");
    expect(pending?.origin).toBe("jsonl");
  });

  it("(b) a foreign JSONL question does not clobber a different PTY-screen question", () => {
    const SID = "pty-owned-sess";
    // A genuine live question originates from the PTY-screen path.
    (server as any).sessionHandlers.handleLiveQuestion(
      SID,
      qParsed("Ready to ship?", ["ship", "wait"]),
    );
    const screenToolUseId = (server as any).pendingQuestions.get(SID).toolUseId;
    expect(screenToolUseId.startsWith("screen:")).toBe(true);
    broadcasts = []; // ignore the screen broadcast

    // An external agent appends a DIFFERENT question into the shared JSONL.
    (server as any).processJsonlQuestions(SID, [
      qLine("Delete everything?", ["confirm", "cancel"], "toolu_foreign"),
    ]);

    // The pending question is untouched — still the PTY one.
    const pending = (server as any).pendingQuestions.get(SID);
    expect(pending.toolUseId).toBe(screenToolUseId);
    expect(pending.origin).toBe("pty");
    // The foreign question was never broadcast.
    expect(broadcasts.some((b) => b.toolUseId === "toolu_foreign")).toBe(false);
  });

  it("re-sync: the SAME question's JSONL flush updates the toolUseId, origin stays pty", () => {
    const SID = "resync-sess";
    (server as any).sessionHandlers.handleLiveQuestion(
      SID,
      qParsed("Merge now?", ["merge", "hold"]),
    );
    broadcasts = [];

    // JSONL flush of the same question carries the real toolUseId.
    (server as any).processJsonlQuestions(SID, [
      qLine("Merge now?", ["merge", "hold"], "toolu_real"),
    ]);

    const pending = (server as any).pendingQuestions.get(SID);
    expect(pending.toolUseId).toBe("toolu_real");
    expect(pending.origin).toBe("pty");
    // Re-broadcast so the client swaps the synthetic screen id for the real one.
    expect(broadcasts.some((b) => b.type === "question" && b.toolUseId === "toolu_real")).toBe(
      true,
    );
  });

  // #724: every answer path keeps the menu's content key until the menu leaves
  // the screen, while nothing is pending. A JSONL flush of that same question
  // landing AFTER the answer is the answered question arriving late — it must
  // not open a fresh actionable prompt (the live probe's 60-second phantom).
  async function answerLiveQuestion(SID: string, questions: AskQuestion[]): Promise<void> {
    const registry = (server as any).promptRegistry;
    vi.spyOn((server as any).ptyManager, "sendKeys").mockImplementation(() => {});
    (server as any).sessionHandlers.handleLiveQuestion(SID, questions);
    const asked = registry.snapshot(SID).prompts[0];
    const outcome = await registry.answer(SID, {
      promptId: asked.promptId,
      revision: asked.revision,
      responses: [
        {
          questionId: asked.questions[0].questionId,
          optionIds: [asked.questions[0].options[0].optionId],
        },
      ],
      idempotencyKey: `idem-${SID}`,
    });
    expect(outcome.ok).toBe(true);
    broadcasts = [];
  }
  const openPrompts = (SID: string) =>
    (server as any).promptRegistry.snapshot(SID).prompts.filter((p: any) => p.state === "open");

  it("#724: a JSONL flush landing after the answer does not re-open the answered question", async () => {
    const SID = "answered-late-sess";
    await answerLiveQuestion(SID, qParsed("Pick a db", ["pg", "sqlite"]));

    (server as any).processJsonlQuestions(SID, [
      qLine("Pick a db", ["pg", "sqlite"], "toolu_late"),
    ]);

    expect(openPrompts(SID)).toHaveLength(0);
    expect((server as any).pendingQuestions.has(SID)).toBe(false);
    expect(broadcasts.some((b) => b.type === "question")).toBe(false);
  });

  it("#724 control: a DIFFERENT question's JSONL flush after an answer still opens", async () => {
    const SID = "answered-then-new-sess";
    await answerLiveQuestion(SID, qParsed("Pick a db", ["pg", "sqlite"]));

    (server as any).processJsonlQuestions(SID, [qLine("Deploy where?", ["eu", "us"], "toolu_new")]);

    expect(openPrompts(SID)).toHaveLength(1);
    expect((server as any).pendingQuestions.get(SID)?.toolUseId).toBe("toolu_new");
    expect(broadcasts.some((b) => b.type === "question" && b.toolUseId === "toolu_new")).toBe(true);
  });

  it("#724 control: the same question re-asked after its menu left the screen still opens", async () => {
    const SID = "answered-then-reasked-sess";
    await answerLiveQuestion(SID, qParsed("Pick a db", ["pg", "sqlite"]));
    // The menu leaving the screen clears the key (onLiveQuestionGone in server-wiring).
    (server as any).pendingQuestionKey.delete(SID);

    (server as any).processJsonlQuestions(SID, [
      qLine("Pick a db", ["pg", "sqlite"], "toolu_again"),
    ]);

    expect(openPrompts(SID)).toHaveLength(1);
    expect((server as any).pendingQuestions.get(SID)?.toolUseId).toBe("toolu_again");
  });
});
