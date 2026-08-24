import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
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
