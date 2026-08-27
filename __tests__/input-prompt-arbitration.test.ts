import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { clearExpiredPendingPrompt } from "../src/server-wiring";
import { PromptRegistry } from "../src/services/prompts/promptRegistry";
import { IdempotencyStore } from "../src/services/sessions/idempotency";
import type { AskQuestion, WSMessage } from "../src/types";

// Semantic input arbitration on POST /input { input }. While a permission gate
// or AskUserQuestion menu is up, the PTY cursor is on the picker, so composer
// text would commit the highlighted option (live capture: prose typed over an
// open card approved a tool call). The handler must refuse with a stable code
// and write ZERO bytes. `{ keys }` is deliberately not arbitrated — Esc and
// arrow navigation are how a card is dismissed or navigated.

const SESSION = "s1";

const QUESTIONS: AskQuestion[] = [
  {
    question: "Which language?",
    header: "Language",
    multiSelect: false,
    options: [
      { label: "TypeScript", description: "" },
      { label: "Rust", description: "" },
    ],
  },
];

const GATE = {
  prompt: "Bash command",
  options: [
    { index: 1, label: "Yes" },
    { index: 2, label: "No" },
  ],
};

interface Harness {
  handlers: SessionHandlers;
  inputs: string[];
  keys: string[];
  idempotency: IdempotencyStore;
  pendingPermission: SessionHandlersDeps["pendingPermission"];
  pendingQuestions: SessionHandlersDeps["pendingQuestions"];
}

function harness(open: "permission" | "question" | null): Harness {
  const inputs: string[] = [];
  const keys: string[] = [];
  const idempotency = new IdempotencyStore();
  const pendingPermission: SessionHandlersDeps["pendingPermission"] = new Map();
  const pendingQuestions: SessionHandlersDeps["pendingQuestions"] = new Map();
  if (open === "permission") pendingPermission.set(SESSION, GATE);
  if (open === "question") {
    pendingQuestions.set(SESSION, { toolUseId: "toolu_1", questions: QUESTIONS, origin: "pty" });
  }

  const deps = {
    checkSessionInputRateLimit: () => true,
    agentConfig: { enabled: false },
    idempotency,
    pendingPermission,
    pendingQuestions,
    sessionFileMap: new Map<string, string>(),
    ptyAttachedIds: () => new Set<string>(),
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    wsHub: { broadcast: (_m: WSMessage) => {} },
    sessionStore: { get: () => null, updateManaged: () => {} },
    ptyManager: {
      sendInput: (_id: string, input: string) => {
        inputs.push(input);
        return 1;
      },
      sendKeys: (_id: string, k: string) => keys.push(k),
    },
  };

  return {
    handlers: new SessionHandlers(deps as unknown as SessionHandlersDeps),
    inputs,
    keys,
    idempotency,
    pendingPermission,
    pendingQuestions,
  };
}

function request(body: Record<string, unknown>): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
}

function response(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0;
  let payload = "";
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk: string) => {
      payload = chunk;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => JSON.parse(payload),
  };
}

describe("POST /input { input } while a prompt is open", () => {
  it.each([
    "permission",
    "question",
  ] as const)("clears an expired %s prompt and lets text input through", async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-26T12:00:00.000Z");
    try {
      const h = harness(null);
      const frames: WSMessage[] = [];
      const deps = (h.handlers as unknown as { deps: SessionHandlersDeps }).deps;
      deps.pendingQuestionKey = new Map();
      deps.pendingPermissionKey = new Map();
      deps.sessionSubscribers = new Map();
      deps.wsHub.broadcastToClients = (_clients, frame) => frames.push(frame);
      const registry = new PromptRegistry({
        onExpire: (prompt) =>
          clearExpiredPendingPrompt(
            {
              pendingPermission: h.pendingPermission,
              pendingPermissionKey: deps.pendingPermissionKey,
              pendingQuestions: h.pendingQuestions,
              pendingQuestionKey: deps.pendingQuestionKey,
              sessionSubscribers: deps.sessionSubscribers,
              wsHub: deps.wsHub,
            },
            prompt,
          ),
      });
      deps.promptRegistry = registry;
      const prompt = registry.open({
        sessionId: SESSION,
        intent: kind === "permission" ? "approval" : "question",
        message: kind === "permission" ? "Allow command?" : "Which language?",
        questions: [
          {
            text: kind === "permission" ? "Allow command?" : "Which language?",
            inputMode: "single",
            options: [{ label: "Yes" }, { label: "No" }],
            allowOther: false,
            secret: "unknown",
          },
        ],
        answerRequirement: "blocking",
        expiresAt: "2026-08-26T12:00:00.100Z",
        provenance: { source: "provider", confidence: "authoritative" },
      });
      if (kind === "permission") {
        h.pendingPermission.set(SESSION, {
          ...GATE,
          gateId: prompt.promptId,
          promptId: prompt.promptId,
        });
        deps.pendingPermissionKey.set(SESSION, "permission-key");
      } else {
        h.pendingQuestions.set(SESSION, {
          toolUseId: "toolu_expiring",
          questions: QUESTIONS,
          origin: "pty",
          promptId: prompt.promptId,
        });
        deps.pendingQuestionKey.set(SESSION, "question-key");
      }

      vi.setSystemTime("2026-08-26T12:00:00.100Z");
      const { res, status, body } = response();
      await h.handlers.handleSendInput(SESSION, request({ input: "hello" }), res);

      expect(status()).toBe(200);
      expect(body()).toEqual({ ok: true });
      expect(h.inputs).toEqual(["hello"]);
      expect(h.pendingPermission.has(SESSION)).toBe(false);
      expect(h.pendingQuestions.has(SESSION)).toBe(false);
      expect(frames).toContainEqual(
        kind === "permission"
          ? { type: "permission_cancelled", sessionId: SESSION }
          : { type: "question_cancelled", sessionId: SESSION, toolUseId: "toolu_expiring" },
      );
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear a newer pending permission when an old prompt expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-26T12:00:00.000Z");
    try {
      const h = harness(null);
      const deps = (h.handlers as unknown as { deps: SessionHandlersDeps }).deps;
      deps.pendingQuestionKey = new Map();
      deps.pendingPermissionKey = new Map();
      deps.sessionSubscribers = new Map();
      const registry = new PromptRegistry({
        onExpire: (prompt) =>
          clearExpiredPendingPrompt(
            {
              pendingPermission: h.pendingPermission,
              pendingPermissionKey: deps.pendingPermissionKey,
              pendingQuestions: h.pendingQuestions,
              pendingQuestionKey: deps.pendingQuestionKey,
              sessionSubscribers: deps.sessionSubscribers,
              wsHub: deps.wsHub,
            },
            prompt,
          ),
      });
      const old = registry.open({
        sessionId: SESSION,
        intent: "approval",
        message: "Old prompt",
        questions: [
          {
            text: "Old prompt",
            inputMode: "single",
            options: [{ label: "Yes" }, { label: "No" }],
            allowOther: false,
            secret: "unknown",
          },
        ],
        answerRequirement: "blocking",
        expiresAt: "2026-08-26T12:00:00.100Z",
        provenance: { source: "provider", confidence: "authoritative" },
      });
      h.pendingPermission.set(SESSION, {
        ...GATE,
        gateId: "new-prompt",
        promptId: "new-prompt",
      });

      vi.setSystemTime("2026-08-26T12:00:00.100Z");
      registry.get(old.promptId);

      expect(h.pendingPermission.get(SESSION)?.promptId).toBe("new-prompt");
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "permission",
    "question",
  ] as const)("refuses with prompt_pending and writes zero bytes (%s)", async (kind) => {
    const h = harness(kind);
    const { res, status, body } = response();
    await h.handlers.handleSendInput(
      SESSION,
      request({ input: "hello", idempotencyKey: "k1" }),
      res,
    );

    expect(status()).toBe(409);
    expect(body()).toMatchObject({ ok: false, reason: "prompt_pending", promptKind: kind });
    expect(h.inputs).toEqual([]);
    expect(h.keys).toEqual([]);
    // A refusal is not a result to replay: the same key must go through once
    // the card is answered.
    expect(h.idempotency.size(SESSION)).toBe(0);
  });

  // Negative control: the same request with no prompt open reaches the PTY.
  // Proves the harness exercises the write, so the empty `inputs` above is a
  // refusal and not a broken stub.
  it("sends the text when nothing is pending", async () => {
    const h = harness(null);
    const { res, status, body } = response();
    await h.handlers.handleSendInput(SESSION, request({ input: "hello" }), res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(h.inputs).toEqual(["hello"]);
  });

  // Raw keys are the dismissal/navigation path and must stay open while a
  // card is up — otherwise Esc could never close the gate that blocks text.
  it("does not arbitrate { keys } while a gate is open", async () => {
    const h = harness("permission");
    const { res, status } = response();
    await h.handlers.handleSendInput(SESSION, request({ keys: "\x1b" }), res);

    expect(status()).toBe(200);
    expect(h.keys).toEqual(["\x1b"]);
    expect(h.inputs).toEqual([]);
  });

  it("lets a resend with the same idempotencyKey through once the gate closes", async () => {
    const h = harness("permission");
    const first = response();
    await h.handlers.handleSendInput(
      SESSION,
      request({ input: "hello", idempotencyKey: "k1" }),
      first.res,
    );
    expect(first.status()).toBe(409);

    h.pendingPermission.delete(SESSION);
    const second = response();
    await h.handlers.handleSendInput(
      SESSION,
      request({ input: "hello", idempotencyKey: "k1" }),
      second.res,
    );
    expect(second.status()).toBe(200);
    expect(h.inputs).toEqual(["hello"]);
  });
});
