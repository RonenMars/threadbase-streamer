import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import type { AskQuestion, WSMessage } from "../src/types";

// Regression: answering a question whose menu already closed used to type the
// arrow keys into the prompt box. The menu closes without this route running
// whenever the user hits Esc (POST /input { keys: "\x1b" }), answers at the host
// keyboard, or runs /clear — and nothing else clears pendingQuestions, so the
// client kept a live-looking card pointed at a dead toolUseId.
//
// Observed 2026-08-15 on session c7ce8de5: Esc at 00:05:42.519, the CLI recorded
// "User declined to answer questions", then POST /answer at 00:05:49.274 wrote
// "\x1b[B\x1b[B\x1b[B\r" — which landed in the composer as a stray "B".

const SESSION = "s1";

const QUESTIONS: AskQuestion[] = [
  {
    question: "What did you actually want here?",
    header: "Intent",
    multiSelect: false,
    options: [
      { label: "It's already done", description: "" },
      { label: "Make Android run on pull_request too", description: "" },
    ],
  },
];

const MENU_OPEN = [
  "  What did you actually want here?",
  "❯ 1. It's already done",
  "  2. Make Android run on pull_request too",
  "  Enter to select · ↑/↓ to navigate · Esc to cancel",
];

// What the screen looks like after Esc: the picker is gone, the prompt is back.
const MENU_CLOSED = [
  "❯ Ask me any question",
  "  Since the workflow already defaults to Android, there's nothing to change.",
  "❯ ",
  "  accept edits on (shift+tab to cycle)",
];

interface Harness {
  handlers: SessionHandlers;
  written: string[];
  broadcasts: WSMessage[];
  pendingQuestions: SessionHandlersDeps["pendingQuestions"];
  pendingQuestionKey: Map<string, string>;
}

function harness(screen: string[], opts: { hasSession?: boolean } = {}): Harness {
  const written: string[] = [];
  const broadcasts: WSMessage[] = [];
  const pendingQuestions: SessionHandlersDeps["pendingQuestions"] = new Map([
    [SESSION, { toolUseId: "toolu_1", questions: QUESTIONS, origin: "jsonl" as const }],
  ]);
  const pendingQuestionKey = new Map<string, string>([[SESSION, "key"]]);

  const deps = {
    pendingQuestions,
    pendingQuestionKey,
    wsHub: { broadcast: (m: WSMessage) => broadcasts.push(m) },
    ptyManager: {
      hasSession: () => opts.hasSession ?? true,
      getOutputLines: async () => screen,
      sendKeys: (_id: string, keys: string) => written.push(keys),
    },
  };

  return {
    handlers: new SessionHandlers(deps as unknown as SessionHandlersDeps),
    written,
    broadcasts,
    pendingQuestions,
    pendingQuestionKey,
  };
}

function request(): IncomingMessage {
  const body = JSON.stringify({
    toolUseId: "toolu_1",
    answers: { "What did you actually want here?": "Make Android run on pull_request too" },
  });
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
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

describe("POST /answer against a menu that already closed", () => {
  let h: Harness;

  describe("menu still on screen", () => {
    beforeEach(() => {
      h = harness(MENU_OPEN);
    });

    it("sends the keystrokes and reports ok", async () => {
      const { res, status, body } = response();
      await h.handlers.handleSendAnswer(SESSION, request(), res);

      expect(h.written).toEqual(["\x1b[B\r"]);
      expect(status()).toBe(200);
      expect(body()).toEqual({ ok: true });
    });
  });

  describe("menu already closed", () => {
    beforeEach(() => {
      h = harness(MENU_CLOSED);
    });

    it("writes NOTHING to the PTY", async () => {
      const { res } = response();
      await h.handlers.handleSendAnswer(SESSION, request(), res);

      expect(h.written).toEqual([]);
    });

    it("reports question_gone rather than a silent success", async () => {
      const { res, status, body } = response();
      await h.handlers.handleSendAnswer(SESSION, request(), res);

      expect(status()).toBe(409);
      expect(body()).toEqual({ ok: false, reason: "question_gone" });
    });

    it("clears the pending question so the stale card can't be answered twice", async () => {
      const { res } = response();
      await h.handlers.handleSendAnswer(SESSION, request(), res);

      expect(h.pendingQuestions.has(SESSION)).toBe(false);
      expect(h.pendingQuestionKey.has(SESSION)).toBe(false);
    });

    it("broadcasts question_cancelled so the client dismisses the card", async () => {
      const { res } = response();
      await h.handlers.handleSendAnswer(SESSION, request(), res);

      expect(h.broadcasts).toEqual([
        { type: "question_cancelled", sessionId: SESSION, toolUseId: "toolu_1" },
      ]);
    });
  });

  describe("no PTY of ours to read", () => {
    it("still sends — an unowned session is not ours to veto", async () => {
      h = harness([], { hasSession: false });
      const { res, status } = response();
      await h.handlers.handleSendAnswer(SESSION, request(), res);

      expect(h.written).toEqual(["\x1b[B\r"]);
      expect(status()).toBe(200);
    });
  });
});
