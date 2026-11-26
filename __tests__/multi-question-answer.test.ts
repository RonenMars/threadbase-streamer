import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { StreamerServer } from "../src/server";
import type { PromptRegistry } from "../src/services/prompts/promptRegistry";
import type { AskQuestion } from "../src/types";
import { DOWN, ENTER, FakeQuestionForm, LEFT, RIGHT, UP } from "./helpers/fake-question-form";

const API_KEY = "tb_multi_question_test_key_00000000";
const SESSION = "multi-question-session";

const option = (label: string) => ({ label, description: "" });
const QUESTIONS: AskQuestion[] = [
  {
    question: "Which colour?",
    header: "A",
    multiSelect: false,
    options: ["Red", "Blue"].map(option),
  },
  {
    question: "Which sizes?",
    header: "B",
    multiSelect: true,
    options: ["Small", "Medium", "Large"].map(option),
  },
  {
    question: "Which shape?",
    header: "C",
    multiSelect: false,
    options: ["Round", "Flat"].map(option),
  },
];
const PICKS = [[1], [0, 2], [1]];

type Gate = { options: { index: number; label: string }[] };
type Internal = {
  sessionHandlers: {
    handleJsonlQuestion: (s: string, id: string, q: AskQuestion[], o: "pty" | "jsonl") => void;
    handleLiveQuestion: (s: string, q: AskQuestion[]) => void;
    deps: { multiAnswerTiming?: { timeoutMs: number; pollMs: number } };
  };
  promptRegistry: PromptRegistry;
  pendingQuestions: Map<string, { toolUseId: string }>;
  pendingQuestionKey: Map<string, string>;
  pendingPermission: Map<string, unknown>;
  sessionGeometry: Map<string, { cols: number; rows: number }>;
  processJsonlQuestions: (s: string, lines: string[]) => void;
  armPhantomQuestionCancel: (s: string, id: string) => void;
  wsHub: {
    broadcast: (message: Record<string, unknown>) => void;
    broadcastToClients: (clients: unknown, message: Record<string, unknown>) => void;
  };
  ptyManager: {
    hasSession: (id: string) => boolean;
    isInputLocked: (id: string) => boolean;
    sendKeys: (id: string, keys: string) => void;
    runnerFor: (id: string) => unknown;
    options: {
      onLiveQuestion: (id: string, q: AskQuestion[]) => void;
      onLiveQuestionGone: (id: string) => void;
      onPermissionChange: (id: string, gate: Gate | null) => void;
    };
  };
};

let server: StreamerServer;
let internal: Internal;
let form: FakeQuestionForm;
let sent: Record<string, unknown>[];
let writes: { via: "keys" | "raw" | "text"; data: string }[];
let resizes: [number, number][];
let screenHeld: Promise<void> | null;
let failResize: (rows: number) => boolean;

beforeEach(async () => {
  server = new StreamerServer({
    port: 0,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    skipStartupWarmup: true,
    cacheDir: mkdtempSync(join(tmpdir(), "tb-multi-question-")),
    scanProfiles: [],
  });
  await server.listen(0);
  internal = server as unknown as Internal;
  internal.sessionHandlers.deps.multiAnswerTiming = { timeoutMs: 150, pollMs: 1 };
  form = new FakeQuestionForm(QUESTIONS);
  writes = [];
  resizes = [];
  screenHeld = null;
  failResize = () => false;
  // Behind runnerFor, so the manager's own write lock is the real one.
  const type = (via: "keys" | "raw", data: string) => {
    writes.push({ via, data });
    form.terminal.write(data);
  };
  internal.ptyManager.hasSession = (id) => id === SESSION;
  internal.ptyManager.runnerFor = () => ({
    hasSession: () => true,
    sendKeys: (_id: string, data: string) => type("keys", data),
    sendRawKeys: (_id: string, data: string) => type("raw", data),
    sendInput: (_id: string, data: string) => {
      writes.push({ via: "text", data });
      return 1;
    },
    resize: (_id: string, cols: number, rows: number) => {
      if (failResize(rows)) throw new Error("resize failed");
      resizes.push([cols, rows]);
      form.rows = rows;
    },
    getOutputLines: async (_id: string, max: number) => {
      await screenHeld;
      return (await form.terminal.read()).slice(-max);
    },
  });
  sent = [];
  internal.wsHub.broadcast = (message) => {
    sent.push(message);
  };
  internal.wsHub.broadcastToClients = (_clients, message) => {
    sent.push(message);
  };
});

afterEach(async () => {
  vi.useRealTimers();
  await server.close();
});

const sentOfType = (type: string) => sent.filter((m) => m.type === type);

function openPrompt(questions: AskQuestion[] = QUESTIONS) {
  internal.sessionHandlers.handleJsonlQuestion(SESSION, "toolu_1", questions, "jsonl");
  return internal.promptRegistry.snapshot(SESSION).prompts[0];
}

type OpenPrompt = ReturnType<typeof openPrompt>;

function answerFor(prompt: OpenPrompt, picks: number[][], idempotencyKey = "key-1") {
  return {
    promptId: prompt.promptId,
    revision: prompt.revision,
    // Reversed: responses are matched by question id, not by position.
    responses: picks
      .map((picked, i) => ({
        questionId: prompt.questions[i].questionId,
        optionIds: picked.map((o) => prompt.questions[i].options[o].optionId),
      }))
      .reverse(),
    idempotencyKey,
  };
}

const post = (path: string, body: unknown) =>
  fetch(`http://localhost:${server.port}/api/sessions/${SESSION}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function answer(prompt: OpenPrompt, picks = PICKS, key = "key-1") {
  const res = await post("prompt/answer", answerFor(prompt, picks, key));
  return { status: res.status, body: await res.json() };
}

// Holds the drive after its first key, so something else can happen mid-sequence.
async function duringDrive<T>(prompt: OpenPrompt, check: () => T | Promise<T>) {
  let release = () => {};
  form.onWrite = (_key, count) => {
    if (count === 1) {
      screenHeld = new Promise((resolve) => {
        release = resolve;
      });
    }
    return undefined;
  };
  const answering = answer(prompt);
  await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
  expect(internal.ptyManager.isInputLocked(SESSION)).toBe(true);
  const result = await check();
  expect(writes).toHaveLength(1);
  release();
  return { result, answered: await answering };
}

describe("answering a multi-question form", () => {
  it("submits every choice, opening a turn only with the final Enter", async () => {
    const prompt = openPrompt();

    const { status, body } = await answer(prompt);

    expect({ status, ok: body.ok }).toEqual({ status: 200, ok: true });
    expect(form.submitted).toEqual(PICKS);
    expect(writes.filter((w) => w.via === "keys")).toEqual([{ via: "keys", data: ENTER }]);
    expect(writes.at(-1)).toEqual({ via: "keys", data: ENTER });
    expect(writes.every((w) => [UP, DOWN, LEFT, RIGHT, ENTER, " "].includes(w.data))).toBe(true);
    expect(internal.pendingQuestions.has(SESSION)).toBe(false);
    expect(internal.pendingQuestionKey.has(SESSION)).toBe(false);
    expect(internal.ptyManager.isInputLocked(SESSION)).toBe(false);
    expect(sentOfType("question_cancelled")).toHaveLength(1);
    expect(sentOfType("terminal_resize")).toEqual([]);
    expect(resizes).toEqual([]);
  });

  it("tells the notifier the question closed, so the next one can push", async () => {
    const closed: unknown[][] = [];
    const reach = server as unknown as {
      waitingInputNotifier: unknown;
      sessionStore: { get: () => unknown };
    };
    reach.sessionStore.get = () => ({ id: SESSION });
    reach.waitingInputNotifier = {
      onPrompt: (...args: unknown[]) => closed.push(args),
      onStatus: () => {},
      dispose: () => {},
    };

    await answer(openPrompt());

    expect(closed).toEqual([[{ id: SESSION }, "question", false]]);
  });

  it("writes nothing for a response missing a question", async () => {
    const prompt = openPrompt();
    const full = answerFor(prompt, PICKS);

    const res = await post("prompt/answer", { ...full, responses: full.responses.slice(1) });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "incomplete_answer" });
    expect(writes).toEqual([]);
  });

  it("writes nothing for typed text, and leaves the prompt open", async () => {
    const prompt = openPrompt();
    const full = answerFor(prompt, PICKS);
    const typed = { questionId: full.responses[0].questionId, text: "other" };

    const res = await post("prompt/answer", {
      ...full,
      responses: [typed, ...full.responses.slice(1)],
    });

    expect(await res.json()).toMatchObject({ code: "incomplete_answer" });
    expect(writes).toEqual([]);
    expect(internal.promptRegistry.get(prompt.promptId)?.state).toBe("open");
  });

  it("writes nothing for a preview form", async () => {
    const questions = QUESTIONS.map((q, i) =>
      i === 0 ? { ...q, options: q.options.map((o) => ({ ...o, preview: "box" })) } : q,
    );
    const prompt = openPrompt(questions);

    const { status, body } = await answer(prompt);

    expect({ status, code: body.code }).toEqual({ status: 400, code: "unsupported_prompt_shape" });
    expect(writes).toEqual([]);
    expect(internal.ptyManager.isInputLocked(SESSION)).toBe(false);
  });

  it("writes nothing when the first question is not on screen, and stays answerable", async () => {
    const prompt = openPrompt();
    form.tab = 1;

    const { status, body } = await answer(prompt);

    expect({ status, code: body.code }).toEqual({ status: 409, code: "form_not_ready" });
    expect(writes).toEqual([]);
    expect(internal.promptRegistry.get(prompt.promptId)?.state).toBe("open");
    expect(internal.ptyManager.isInputLocked(SESSION)).toBe(false);

    form.tab = 0;
    expect((await answer(prompt, PICKS, "key-2")).status).toBe(200);
  });

  it("reports provider_error when the first key cannot be written", async () => {
    const prompt = openPrompt();
    form.terminal.write = () => {
      throw new Error("pty gone");
    };

    const { status, body } = await answer(prompt);

    expect({ status, code: body.code }).toEqual({ status: 502, code: "provider_error" });
    expect(internal.ptyManager.isInputLocked(SESSION)).toBe(false);
    expect(internal.promptRegistry.get(prompt.promptId)?.state).toBe("open");
  });

  describe("terminal geometry", () => {
    const tall = () => {
      form = new FakeQuestionForm(QUESTIONS, [0, 45, 0]);
      form.tab = 0;
    };

    it("grows for a form that scrolled, then restores the spawn size", async () => {
      tall();
      const prompt = openPrompt();

      const { status } = await answer(prompt);

      expect(status).toBe(200);
      expect(form.submitted).toEqual(PICKS);
      expect(resizes).toEqual([
        [120, 100],
        [120, 40],
      ]);
      expect(sentOfType("terminal_resize")).toEqual([
        { type: "terminal_resize", sessionId: SESSION, cols: 120, rows: 100 },
        { type: "terminal_resize", sessionId: SESSION, cols: 120, rows: 40 },
      ]);
      expect(internal.sessionGeometry.has(SESSION)).toBe(false);
    });

    it("still reports answered when restoring the size fails", async () => {
      tall();
      const prompt = openPrompt();
      // The grow works; the restore after the submit does not.
      failResize = (rows) => rows === 40;

      const { status } = await answer(prompt);

      expect(status).toBe(200);
      expect(internal.promptRegistry.get(prompt.promptId)?.state).toBe("resolved");
      expect(internal.pendingQuestions.has(SESSION)).toBe(false);
    });

    it("restores the size a client had set", async () => {
      tall();
      internal.sessionGeometry.set(SESSION, { cols: 90, rows: 42 });
      form.rows = 42;
      const prompt = openPrompt();

      await answer(prompt);

      expect(resizes).toEqual([
        [90, 100],
        [90, 42],
      ]);
      expect(internal.sessionGeometry.get(SESSION)).toEqual({ cols: 90, rows: 42 });
    });

    it("reads as many rows as the client's terminal has", async () => {
      // 60 rows: this form fits there and would be cut to nothing at 40.
      tall();
      internal.sessionGeometry.set(SESSION, { cols: 120, rows: 70 });
      form.rows = 70;
      const prompt = openPrompt();

      const { status } = await answer(prompt);

      expect(status).toBe(200);
      expect(resizes).toEqual([]);
    });

    it("restores the size after a form too tall even when grown", async () => {
      form = new FakeQuestionForm(QUESTIONS, [130, 0, 0]);
      const prompt = openPrompt();

      const { status, body } = await answer(prompt);

      expect({ status, code: body.code }).toEqual({
        status: 400,
        code: "unsupported_prompt_shape",
      });
      expect(writes).toEqual([]);
      expect(resizes.at(-1)).toEqual([120, 40]);
      expect(internal.ptyManager.isInputLocked(SESSION)).toBe(false);
    });
  });

  describe("after a partial answer", () => {
    async function partial() {
      const prompt = openPrompt();
      // The second key is dropped: the screen never shows its effect.
      form.onWrite = (_key, count) => (count === 2 ? "ignore" : undefined);
      const result = await answer(prompt);
      form.onWrite = null;
      return { prompt, result };
    }

    it("answers 409 partly_answered and is not retryable", async () => {
      const { prompt, result } = await partial();
      const written = writes.length;

      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ ok: false, code: "partly_answered" });
      expect(internal.promptRegistry.get(prompt.promptId)).toMatchObject({
        state: "unavailable",
        terminalReason: "partly_answered",
      });
      expect((await answer(prompt)).body).toMatchObject({ code: "partly_answered" });
      expect((await answer(prompt, PICKS, "key-2")).status).toBe(409);
      expect(writes).toHaveLength(written);
      expect(internal.ptyManager.isInputLocked(SESSION)).toBe(false);
    });

    it("closes the card and keeps composer text refused", async () => {
      await partial();

      const res = await post("input", { input: "hello" });

      expect(sentOfType("question_cancelled")).toHaveLength(1);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "prompt_pending", promptState: "open" });
      expect(writes.some((w) => w.via === "text")).toBe(false);
    });

    it("raises no card from a tab of the half-answered form", async () => {
      await partial();
      sent.length = 0;

      internal.sessionHandlers.handleLiveQuestion(SESSION, [QUESTIONS[1]]);

      expect(sentOfType("question")).toEqual([]);
      expect(
        internal.promptRegistry.snapshot(SESSION).prompts.filter((p) => p.state === "open"),
      ).toEqual([]);
    });

    it("still shows a different question", async () => {
      await partial();
      sent.length = 0;

      internal.sessionHandlers.handleLiveQuestion(SESSION, [
        { question: "Something new?", header: "N", multiSelect: false, options: [option("Yes")] },
      ]);

      expect(sentOfType("question")).toHaveLength(1);
    });

    it("keeps the composer locked when the menu detector reports the form gone", async () => {
      await partial();
      form.tab = QUESTIONS.length; // the review screen has no menu footer

      internal.ptyManager.options.onLiveQuestionGone(SESSION);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(internal.pendingQuestions.has(SESSION)).toBe(true);
    });

    it("releases the composer at the 60s check once the form has left the screen", async () => {
      await partial();
      form.submitted = [[0], [0], [0]];
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      internal.armPhantomQuestionCancel(SESSION, "toolu_1");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(internal.pendingQuestions.has(SESSION)).toBe(false);
    });

    it("keeps it through the 60s check while the review is on screen", async () => {
      await partial();
      form.tab = QUESTIONS.length;
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      internal.armPhantomQuestionCancel(SESSION, "toolu_1");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(internal.pendingQuestions.has(SESSION)).toBe(true);
    });

    it("does not replay the closed card to a new subscriber", async () => {
      await partial();
      const received: Record<string, unknown>[] = [];
      const ws = new WebSocket(`ws://localhost:${server.port}/ws?key=${API_KEY}`);
      await new Promise((resolve) => ws.once("open", resolve));
      ws.on("message", (raw) => received.push(JSON.parse(String(raw))));

      ws.send(JSON.stringify({ type: "subscribe_session", sessionId: SESSION }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      ws.close();

      expect(received.filter((m) => m.type === "question")).toEqual([]);
    });
  });

  describe("while the form is being driven", () => {
    it("refuses every other writer and a second answer writes nothing more", async () => {
      const prompt = openPrompt();

      const { result, answered } = await duringDrive(prompt, async () => {
        const text = await post("input", { input: "hello" });
        const keys = await post("input", { keys: "\r" });
        const escaped = await post("raw-key", { action: "escape" });
        const direct = () => internal.ptyManager.sendKeys(SESSION, "x");
        expect(direct).toThrow(/answering/i);
        return {
          text: [text.status, await text.json()],
          keys: keys.status,
          escape: [escaped.status, await escaped.json()],
          // Same idempotency key while the first is in flight.
          repeat: answer(prompt),
        };
      });

      expect(result.text[0]).toBe(409);
      expect(result.keys).toBe(409);
      expect(result.escape[0]).toBe(409);
      expect(answered.status).toBe(200);
      expect((await result.repeat).status).toBe(200);
      expect(form.submitted).toEqual(PICKS);
      expect(writes.filter((w) => w.via !== "raw")).toEqual([{ via: "keys", data: ENTER }]);
    });

    it("lets no screen or transcript event reach clients or replace the prompt", async () => {
      const prompt = openPrompt();

      const { answered } = await duringDrive(prompt, () => {
        sent.length = 0;
        const { options } = internal.ptyManager;
        options.onLiveQuestion(SESSION, [QUESTIONS[1]]);
        options.onLiveQuestion(SESSION, []);
        options.onPermissionChange(SESSION, {
          options: [
            { index: 1, label: "Submit answers" },
            { index: 2, label: "Cancel" },
          ],
        });
        options.onLiveQuestionGone(SESSION);
        options.onPermissionChange(SESSION, null);
        internal.sessionHandlers.handleJsonlQuestion(SESSION, "toolu_2", [QUESTIONS[0]], "jsonl");
        internal.processJsonlQuestions(SESSION, [
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "toolu_3",
                  name: "AskUserQuestion",
                  input: { questions: [QUESTIONS[2]] },
                },
              ],
            },
          }),
        ]);
        expect(sent).toEqual([]);
        expect(internal.pendingPermission.has(SESSION)).toBe(false);
        expect(internal.pendingQuestions.get(SESSION)?.toolUseId).toBe("toolu_1");
        expect(internal.promptRegistry.get(prompt.promptId)?.state).toBe("open");
      });

      expect(answered.status).toBe(200);
    });

    it("is not cancelled by the 60s check", async () => {
      const prompt = openPrompt();
      form.onWrite = (_key, count) => (count === 1 ? "ignore" : undefined);
      internal.sessionHandlers.deps.multiAnswerTiming = { timeoutMs: 120_000, pollMs: 1000 };
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      const answering = internal.promptRegistry.answer(SESSION, answerFor(prompt, PICKS));
      await vi.advanceTimersByTimeAsync(10);
      form.tab = QUESTIONS.length;
      internal.armPhantomQuestionCancel(SESSION, "toolu_1");
      form.override = () => ["nothing recognisable"];

      await vi.advanceTimersByTimeAsync(61_000);

      expect(internal.pendingQuestions.has(SESSION)).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      await answering;
    });
  });

  it("advertises multiQuestion", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/info`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(await res.json()).toMatchObject({ promptContract: { multiQuestion: true } });
  });
});
