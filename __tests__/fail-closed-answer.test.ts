import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import type { AskQuestion, WSMessage } from "../src/types";

// POST /answer fails closed on prompt shapes the PTY keystroke path cannot
// answer: a multi-question form, a multi-select question, or an answer for a
// question that was never given. Each is a typed 400, and — the point of this
// file — strictly zero bytes reach the PTY. Asserted on the real route with a
// fake runner that records every sendKeys call.
//
// Before: a missing answer threw a bare Error that surfaced as a 500, and a
// multi-select question was "answered" with its first label.

const SESSION = "s1";
const TOOL_USE = "toolu_1";

const option = (label: string) => ({ label, description: "" });
const single: AskQuestion = {
  question: "Which language?",
  header: "Language",
  multiSelect: false,
  options: [option("TypeScript"), option("Rust")],
};
const multiSelect: AskQuestion = { ...single, multiSelect: true };
const second: AskQuestion = {
  question: "Which framework?",
  header: "Framework",
  multiSelect: false,
  options: [option("Hono"), option("Express")],
};

// A menu is on screen, so the freshness check would let a valid answer through.
const MENU_OPEN = [
  "  Which language?",
  "❯ 1. TypeScript",
  "  2. Rust",
  "  Enter to select · ↑/↓ to navigate · Esc to cancel",
];

interface Harness {
  handlers: SessionHandlers;
  written: string[];
  broadcasts: WSMessage[];
  pendingQuestions: SessionHandlersDeps["pendingQuestions"];
}

function harness(questions: AskQuestion[]): Harness {
  const written: string[] = [];
  const broadcasts: WSMessage[] = [];
  const pendingQuestions: SessionHandlersDeps["pendingQuestions"] = new Map([
    [SESSION, { toolUseId: TOOL_USE, questions, origin: "jsonl" as const }],
  ]);
  const deps = {
    pendingQuestions,
    pendingQuestionKey: new Map<string, string>([[SESSION, "key"]]),
    wsHub: { broadcast: (m: WSMessage) => broadcasts.push(m) },
    ptyManager: {
      hasSession: () => true,
      getOutputLines: async () => MENU_OPEN,
      sendKeys: (_id: string, keys: string) => written.push(keys),
    },
  };
  return {
    handlers: new SessionHandlers(deps as unknown as SessionHandlersDeps),
    written,
    broadcasts,
    pendingQuestions,
  };
}

function request(answers: Record<string, string | string[]>): IncomingMessage {
  const body = JSON.stringify({ toolUseId: TOOL_USE, answers });
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function response(): { res: ServerResponse; status: () => number; body: () => any } {
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

async function refused(h: Harness, answers: Record<string, string | string[]>, reason: string) {
  const { res, status, body } = response();
  await h.handlers.handleSendAnswer(SESSION, request(answers), res);
  expect(status()).toBe(400);
  expect(body()).toMatchObject({ ok: false, reason });
  expect(typeof body().error).toBe("string"); // guidance for clients that predate the reason
  expect(h.written).toEqual([]); // strictly zero bytes
  // The prompt is still up and still the client's to answer some other way.
  expect(h.pendingQuestions.has(SESSION)).toBe(true);
  expect(h.broadcasts.some((m) => m.type === "question_cancelled")).toBe(false);
}

describe("POST /answer fails closed with zero bytes written", () => {
  it("multi-question form answered one question at a time (what released mobile sends) → unsupported_prompt_shape", async () => {
    await refused(
      harness([single, second]),
      { "Which language?": "TypeScript" },
      "unsupported_prompt_shape",
    );
  });

  it("multi-question form with every answer supplied → unsupported_prompt_shape", async () => {
    await refused(
      harness([single, second]),
      { "Which language?": "TypeScript", "Which framework?": "Hono" },
      "unsupported_prompt_shape",
    );
  });

  it("multi-select question with a valid label → unsupported_prompt_shape", async () => {
    await refused(
      harness([multiSelect]),
      { "Which language?": "TypeScript" },
      "unsupported_prompt_shape",
    );
  });

  it("two labels for a single-select question → unsupported_prompt_shape", async () => {
    await refused(
      harness([single]),
      { "Which language?": ["TypeScript", "Rust"] },
      "unsupported_prompt_shape",
    );
  });

  it("single-select question with no answer → incomplete_answer", async () => {
    await refused(harness([single]), {}, "incomplete_answer");
  });

  // Positive control: the supported shape reaches the PTY through this very
  // harness, so the empty `written` above is a refusal, not a broken stub.
  it("one single-select question, one label → 200 and the keystrokes are written", async () => {
    const h = harness([single]);
    const { res, status, body } = response();
    await h.handlers.handleSendAnswer(SESSION, request({ "Which language?": "Rust" }), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(h.written).toEqual(["\x1b[B\r"]);
    expect(h.broadcasts.some((m) => m.type === "question_cancelled")).toBe(true);
  });
});
