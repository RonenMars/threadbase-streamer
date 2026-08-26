import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { WebSocket } from "ws";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { PromptRegistry } from "../src/services/prompts/promptRegistry";
import {
  permissionPromptDraft,
  questionPromptDraft,
} from "../src/services/prompts/ptyPromptAdapter";
import {
  detectGateScreen,
  permissionGateKey,
} from "../src/services/questions/detectPermissionGate";
import type { AskQuestion, WSMessage } from "../src/types";

const SESSION = "session-1";
const GATE_SCREEN = [
  "╭──────────────────────────────────────────────────────╮",
  "│ Bash command                                         │",
  "│ npm test                                             │",
  "│ Do you want to proceed?                              │",
  "│ ❯ 2. Yes                                             │",
  "│   3. No                                              │",
  "│ Esc to cancel · Tab to amend                         │",
  "╰──────────────────────────────────────────────────────╯",
];
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

describe("PTY prompt normalization", () => {
  it("maps a permission gate without leaking provider answer keys", () => {
    const gate = detectGateScreen(GATE_SCREEN);
    const draft = permissionPromptDraft(SESSION, gate);

    expect(draft).toMatchObject({
      sessionId: SESSION,
      intent: "approval",
      answerRequirement: "unknown",
      expiresAt: null,
      provenance: { source: "screen", confidence: "inferred" },
      questions: [
        {
          inputMode: "single",
          allowOther: false,
          secret: "unknown",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    });
    expect(JSON.stringify(draft)).not.toContain("answerKeys");
    expect(JSON.stringify(draft)).not.toContain('"index"');
  });

  it("maps JSONL questions as authoritative transcript provenance", () => {
    const draft = questionPromptDraft(SESSION, QUESTIONS, "transcript");

    expect(draft).toMatchObject({
      intent: "question",
      message: "Which language?",
      title: "Language",
      provenance: { source: "transcript", confidence: "authoritative" },
      questions: [
        {
          text: "Which language?",
          inputMode: "single",
          secret: "unknown",
          options: [
            { label: "TypeScript", description: "Typed JavaScript" },
            { label: "Rust", description: "Systems language" },
          ],
        },
      ],
    });
  });
});

type Frame = WSMessage | { type: "prompt_event"; sequence: number; prompt: any };

function harness(
  options: { hasSession?: boolean; outputLines?: string[] | Promise<string[]> } = {},
) {
  const frames: Frame[] = [];
  const written: string[] = [];
  const pendingPermission: SessionHandlersDeps["pendingPermission"] = new Map();
  const pendingQuestions: SessionHandlersDeps["pendingQuestions"] = new Map();
  let next = 0;
  const registry = new PromptRegistry({
    createId: () => `opaque-${++next}`,
    emit: (event) => frames.push(event),
  });
  const deps = {
    promptRegistry: registry,
    pendingPermission,
    pendingPermissionKey: new Map(),
    pendingQuestions,
    pendingQuestionKey: new Map(),
    sessionSubscribers: new Map<string, Set<WebSocket>>(),
    wsHub: {
      broadcastToClients: (_clients: Iterable<WebSocket>, frame: WSMessage) => frames.push(frame),
    },
    sessionStore: { getManaged: () => null },
    ptyManager: {
      hasSession: () => options.hasSession ?? false,
      getOutputLines: () => options.outputLines ?? [],
      sendKeys: (_sessionId: string, keys: string) => written.push(keys),
    },
    log: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
  };
  return {
    handlers: new SessionHandlers(deps as unknown as SessionHandlersDeps),
    frames,
    registry,
    pendingPermission,
    pendingQuestions,
    written,
  };
}

describe("legacy and provider-neutral producer events", () => {
  it("opens one registry prompt beside the legacy permission event", () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));

    const legacy = h.frames.find((frame) => frame.type === "permission");
    const normalized = h.frames.find((frame) => frame.type === "prompt_event") as any;
    expect(legacy).toMatchObject({ type: "permission", sessionId: SESSION });
    expect(normalized).toMatchObject({
      type: "prompt_event",
      sequence: 1,
      prompt: { state: "open", intent: "approval", revision: 1 },
    });
    expect((legacy as Extract<WSMessage, { type: "permission" }>).gateId).toBe(
      normalized.prompt.promptId,
    );
  });

  it("keeps an optionless OSC fallback legacy-only until the gate is actionable", () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, { options: [] });

    expect(h.frames.some((frame) => frame.type === "permission")).toBe(true);
    expect(h.frames.some((frame) => frame.type === "prompt_event")).toBe(false);

    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));

    expect(h.frames.find((frame) => frame.type === "prompt_event")).toMatchObject({
      prompt: {
        state: "open",
        questions: [{ options: [{ label: "Yes" }, { label: "No" }] }],
      },
    });
  });

  it("maps an opaque permission option back to the provider answer bytes", async () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    const prompt = h.registry.snapshot(SESSION).prompts[0];

    const outcome = await h.registry.answer(SESSION, {
      promptId: prompt.promptId,
      revision: prompt.revision,
      responses: [
        {
          questionId: prompt.questions[0].questionId,
          optionIds: [prompt.questions[0].options[1].optionId],
        },
      ],
      idempotencyKey: "permission-answer-1",
    });

    expect(outcome.ok).toBe(true);
    expect(h.written).toEqual(["3\r"]);
  });

  it("does not write an old permission answer after a new gate replaces it", async () => {
    let releaseScreen: (lines: string[]) => void = () => {};
    let screenReadStarted: () => void = () => {};
    const screenRead = new Promise<string[]>((resolve) => {
      releaseScreen = resolve;
    });
    const started = new Promise<void>((resolve) => {
      screenReadStarted = resolve;
    });
    const h = harness({ hasSession: true, outputLines: screenRead });
    const getOutputLines = (h.handlers as unknown as { deps: SessionHandlersDeps }).deps.ptyManager
      .getOutputLines as () => Promise<string[]>;
    (h.handlers as unknown as { deps: SessionHandlersDeps }).deps.ptyManager.getOutputLines =
      () => {
        screenReadStarted();
        return getOutputLines();
      };
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    const prompt = h.registry.snapshot(SESSION).prompts[0];
    const pending = h.registry.answer(SESSION, {
      promptId: prompt.promptId,
      revision: prompt.revision,
      responses: [
        {
          questionId: prompt.questions[0].questionId,
          optionIds: [prompt.questions[0].options[1].optionId],
        },
      ],
      idempotencyKey: "replaced-permission-answer",
    });
    await started;

    h.handlers.handlePermissionChange(
      SESSION,
      detectGateScreen(GATE_SCREEN.map((line) => line.replace("npm test", "npm publish"))),
    );
    releaseScreen(GATE_SCREEN);

    await expect(pending).resolves.toEqual({ ok: false, code: "prompt_cancelled" });
    expect(h.written).toEqual([]);
  });

  it("marks the normalized permission resolved when a legacy client answers", async () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    const gate = h.pendingPermission.get(SESSION);
    const req = Readable.from([
      Buffer.from(
        JSON.stringify({
          contentKey: permissionGateKey(gate ?? { options: [] }),
          optionIndex: 0,
          gateId: gate?.gateId,
        }),
      ),
    ]) as unknown as IncomingMessage;
    const res = { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;

    await h.handlers.handlePermissionAnswer(SESSION, req, res);

    expect(h.registry.get(gate?.promptId ?? "")?.state).toBe("resolved");
    expect(() => h.handlers.handlePermissionChange(SESSION, null)).not.toThrow();
  });

  it("opens a new permission after the resolved gate is replaced before its close signal", async () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    const first = h.registry.snapshot(SESSION).prompts[0];
    await h.registry.answer(SESSION, {
      promptId: first.promptId,
      revision: first.revision,
      responses: [
        {
          questionId: first.questions[0].questionId,
          optionIds: [first.questions[0].options[0].optionId],
        },
      ],
      idempotencyKey: "resolved-before-replacement",
    });

    h.handlers.handlePermissionChange(
      SESSION,
      detectGateScreen(GATE_SCREEN.map((line) => line.replace("npm test", "npm publish"))),
    );

    const actionable = h.registry
      .snapshot(SESSION)
      .prompts.filter((prompt) => prompt.state === "open" || prompt.state === "updated");
    expect(actionable).toHaveLength(1);
    expect(actionable[0].promptId).not.toBe(first.promptId);
  });

  it("does not collapse identical host gates with different occurrence ids", async () => {
    const h = harness();
    const gate = detectGateScreen(GATE_SCREEN);
    h.handlers.handlePermissionChange(SESSION, gate, "host-occurrence-a");
    const first = h.registry.get("host-occurrence-a");
    await h.registry.answer(SESSION, {
      promptId: first?.promptId ?? "",
      revision: first?.revision ?? 0,
      responses: [
        {
          questionId: first?.questions[0].questionId ?? "",
          optionIds: [first?.questions[0].options[0].optionId ?? ""],
        },
      ],
      idempotencyKey: "identical-host-gate-a",
    });

    h.handlers.handlePermissionChange(SESSION, gate, "host-occurrence-b");

    expect(h.registry.get("host-occurrence-b")?.state).toBe("open");
  });

  it("cancels the normalized permission when a legacy answer finds the gate closed", async () => {
    const h = harness({ hasSession: true, outputLines: [] });
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    const gate = h.pendingPermission.get(SESSION);
    const req = Readable.from([
      Buffer.from(
        JSON.stringify({
          contentKey: permissionGateKey(gate ?? { options: [] }),
          optionIndex: 0,
          gateId: gate?.gateId,
        }),
      ),
    ]) as unknown as IncomingMessage;
    const res = { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;

    await h.handlers.handlePermissionAnswer(SESSION, req, res);

    expect(h.registry.get(gate?.promptId ?? "")?.state).toBe("cancelled");
  });

  it("does not revise the normalized prompt for a cursor-only repaint", () => {
    const h = harness();
    const gate = detectGateScreen(GATE_SCREEN);
    h.handlers.handlePermissionChange(SESSION, gate);
    h.handlers.handlePermissionChange(SESSION, { ...gate, cursor: 3 });

    expect(h.frames.filter((frame) => frame.type === "prompt_event")).toHaveLength(1);
    expect(h.frames.filter((frame) => frame.type === "permission")).toHaveLength(2);
  });

  it("publishes terminal cancellation beside the legacy close event", () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    h.handlers.handlePermissionChange(SESSION, null);

    const promptEvents = h.frames.filter((frame) => frame.type === "prompt_event") as any[];
    expect(promptEvents.map((frame) => frame.prompt.state)).toEqual(["open", "cancelled"]);
    expect(h.frames.some((frame) => frame.type === "permission_cancelled")).toBe(true);
  });

  it("opens a normalized question beside the legacy question event", () => {
    const h = harness();
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS);

    expect(h.frames.some((frame) => frame.type === "question")).toBe(true);
    expect(h.frames.find((frame) => frame.type === "prompt_event")).toMatchObject({
      prompt: { intent: "question", state: "open" },
    });
    expect(h.pendingQuestions.get(SESSION)?.promptId).toBeTruthy();
  });

  it("does not collapse identical host questions with different occurrence ids", async () => {
    const h = harness();
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS, "host-question-a");
    const first = h.registry.get("host-question-a");
    await h.registry.answer(SESSION, {
      promptId: first?.promptId ?? "",
      revision: first?.revision ?? 0,
      responses: [
        {
          questionId: first?.questions[0].questionId ?? "",
          optionIds: [first?.questions[0].options[0].optionId ?? ""],
        },
      ],
      idempotencyKey: "identical-host-question-a",
    });

    h.handlers.handleLiveQuestion(SESSION, QUESTIONS, "host-question-b");

    expect(h.registry.get("host-question-b")?.state).toBe("open");
  });

  it("maps an opaque question option back to the rendered picker bytes", async () => {
    const h = harness();
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS);
    const prompt = h.registry.snapshot(SESSION).prompts[0];

    const outcome = await h.registry.answer(SESSION, {
      promptId: prompt.promptId,
      revision: prompt.revision,
      responses: [
        {
          questionId: prompt.questions[0].questionId,
          optionIds: [prompt.questions[0].options[1].optionId],
        },
      ],
      idempotencyKey: "question-answer-1",
    });

    expect(outcome.ok).toBe(true);
    expect(h.written).toEqual(["\u001b[B\r"]);
  });

  it("does not write an old question answer after a new menu replaces it", async () => {
    let releaseScreen: (lines: string[]) => void = () => {};
    let screenReadStarted: () => void = () => {};
    const screenRead = new Promise<string[]>((resolve) => {
      releaseScreen = resolve;
    });
    const started = new Promise<void>((resolve) => {
      screenReadStarted = resolve;
    });
    const h = harness({ hasSession: true, outputLines: screenRead });
    const getOutputLines = (h.handlers as unknown as { deps: SessionHandlersDeps }).deps.ptyManager
      .getOutputLines as () => Promise<string[]>;
    (h.handlers as unknown as { deps: SessionHandlersDeps }).deps.ptyManager.getOutputLines =
      () => {
        screenReadStarted();
        return getOutputLines();
      };
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS);
    const prompt = h.registry.snapshot(SESSION).prompts[0];
    const pending = h.registry.answer(SESSION, {
      promptId: prompt.promptId,
      revision: prompt.revision,
      responses: [
        {
          questionId: prompt.questions[0].questionId,
          optionIds: [prompt.questions[0].options[1].optionId],
        },
      ],
      idempotencyKey: "replaced-question-answer",
    });
    await started;

    h.handlers.handleLiveQuestion(SESSION, [
      {
        question: "Which database?",
        header: "Database",
        multiSelect: false,
        options: [{ label: "SQLite" }, { label: "Postgres" }],
      },
    ]);
    releaseScreen(["Enter to select"]);

    await expect(pending).resolves.toEqual({ ok: false, code: "prompt_cancelled" });
    expect(h.written).toEqual([]);
  });

  it("marks the normalized question resolved when a legacy client answers", async () => {
    const h = harness();
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS);
    const pending = h.pendingQuestions.get(SESSION);
    const req = Readable.from([
      Buffer.from(
        JSON.stringify({
          toolUseId: pending?.toolUseId,
          answers: { "Which language?": "Rust" },
        }),
      ),
    ]) as unknown as IncomingMessage;
    const res = { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;

    await h.handlers.handleSendAnswer(SESSION, req, res);

    expect(h.registry.get(pending?.promptId ?? "")?.state).toBe("resolved");
  });

  it("cancels the normalized question when a legacy answer finds the menu gone", async () => {
    const h = harness({ hasSession: true, outputLines: [] });
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS);
    const pending = h.pendingQuestions.get(SESSION);
    const req = Readable.from([
      Buffer.from(
        JSON.stringify({
          toolUseId: pending?.toolUseId,
          answers: { "Which language?": "Rust" },
        }),
      ),
    ]) as unknown as IncomingMessage;
    const res = { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;

    await h.handlers.handleSendAnswer(SESSION, req, res);

    expect(h.registry.get(pending?.promptId ?? "")?.state).toBe("cancelled");
  });
});
