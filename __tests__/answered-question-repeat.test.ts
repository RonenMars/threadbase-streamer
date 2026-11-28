// An answered AskUserQuestion must not come back: neither as a repaint of its
// menu nor as the transcript copy, which Claude flushes only after the answer.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { StreamerServer } from "../src/server";
import type { AskQuestion } from "../src/types";

const QUESTION = "How should it apply?";
const REAL = ["Opt-in", "Default", "This PC"];
// The rendered menu adds the TUI's own two rows.
const SCREEN = [...REAL, "Type something.", "Chat about this"];

const parsed = (question: string, labels: string[]): AskQuestion[] => [
  {
    question,
    header: "",
    multiSelect: false,
    options: labels.map((label) => ({ label, description: "" })),
  },
];

// Claude stamps the line when it asks, even when it flushes it after the answer.
const toolUseLine = (id: string, askedAt: number) =>
  JSON.stringify({
    timestamp: new Date(askedAt).toISOString(),
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "AskUserQuestion",
          input: { questions: parsed(QUESTION, REAL) },
        },
      ],
    },
  });

const BEFORE_ANSWER = () => Date.now() - 60_000;
const AFTER_ANSWER = () => Date.now() + 60_000;

describe("an answered question does not come back", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let sent: string[];
  let s: any;

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    cacheDir = mkdtempSync(join(tmpdir(), "tb-answered-q-"));
    server = new StreamerServer({
      port: 0,
      apiKey: "tb_test_answered_q",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(0);
    s = server;
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sent = [];
    const record = (msg: unknown) => {
      const { type } = msg as { type: string };
      if (type === "question") sent.push(type);
    };
    vi.spyOn(s.wsHub, "broadcastToClients").mockImplementation((...args: unknown[]) =>
      record(args[1]),
    );
    vi.spyOn(s.sessionHandlers, "broadcastToSession").mockImplementation((...args: unknown[]) =>
      record(args[1]),
    );
    vi.spyOn(s.ptyManager, "sendKeys").mockImplementation(() => {});
    vi.spyOn(s.sessionHandlers, "questionMenuStillOpen").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Show the screen card and answer it through the prompt contract.
  async function askAndAnswer(sid: string) {
    s.sessionHandlers.handleLiveQuestion(sid, parsed(QUESTION, SCREEN));
    const prompt = s.promptRegistry.get(s.pendingQuestions.get(sid).promptId);
    const question = prompt.questions[0];
    const outcome = await s.promptRegistry.answer(sid, {
      promptId: prompt.promptId,
      revision: prompt.revision,
      idempotencyKey: `k-${sid}`,
      responses: [{ questionId: question.questionId, optionIds: [question.options[1].optionId] }],
    });
    expect(outcome.ok).toBe(true);
    sent = [];
  }

  // What onLiveQuestionGone does when the menu leaves the screen.
  const menuGone = (sid: string) => {
    s.pendingQuestionKey.delete(sid);
    s.cancelPendingQuestion(sid);
  };

  it("ignores a repaint that differs only in its options", async () => {
    await askAndAnswer("repaint");

    s.sessionHandlers.handleLiveQuestion("repaint", parsed(QUESTION, SCREEN.slice(1)));

    expect(sent).toEqual([]);
    expect(s.pendingQuestions.has("repaint")).toBe(false);
  });

  it("ignores the late transcript copy while the menu key is still held", async () => {
    await askAndAnswer("late");

    s.processJsonlQuestions("late", [toolUseLine("toolu_1", BEFORE_ANSWER())]);

    expect(sent).toEqual([]);
    expect(s.pendingQuestions.has("late")).toBe(false);
  });

  it("ignores the late transcript copy after the menu has left the screen", async () => {
    await askAndAnswer("gone");
    menuGone("gone");

    s.processJsonlQuestions("gone", [toolUseLine("toolu_1", BEFORE_ANSWER())]);

    expect(sent).toEqual([]);
    expect(s.pendingQuestions.has("gone")).toBe(false);
  });

  it("shows the same wording asked after the answer, from the transcript", async () => {
    await askAndAnswer("newcall");
    menuGone("newcall");

    s.processJsonlQuestions("newcall", [toolUseLine("toolu_2", AFTER_ANSWER())]);

    expect(sent).toEqual(["question"]);
  });

  it("shows the same wording again from the screen once the menu has left it", async () => {
    await askAndAnswer("again");
    menuGone("again");

    s.sessionHandlers.handleLiveQuestion("again", parsed(QUESTION, SCREEN));

    expect(sent).toEqual(["question"]);
  });
});
