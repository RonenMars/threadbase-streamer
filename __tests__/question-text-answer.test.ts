import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import type { AskQuestion, WSMessage } from "../src/types";

// POST /answer for the two terminal-only rows of Claude Code's AskUserQuestion
// menu (captured on 2.1.328, fixtures in __tests__/fixtures/ask-user-question):
//
//  - "Chat about this" is a plain row: DOWN×index then Enter.
//  - "Type something." is a live text field the moment the cursor lands on it.
//    The text must not go in before the cursor is there, and the closing Enter
//    must not share a write with the text (a raw CR inside a burst is read as
//    part of the text, and Enter on an empty field declines the question). So
//    the handler navigates, waits on the rendered screen, writes the text,
//    waits for it to render, then presses Enter.
//
// The fake PTY below is stateful: it moves a cursor on DOWN/UP, takes text only
// while the cursor is on the Type row, and paints a screen shaped like the
// capture, so every wait in the handler is exercised for real.

const SESSION = "s1";
const TOOL_USE = "toolu_1";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

const option = (label: string) => ({ label, description: "" });
const colour: AskQuestion = {
  question: "Pick a colour?",
  header: "Colour",
  multiSelect: false,
  options: [option("Red"), option("Green"), option("Blue")],
};

interface FakePtyOptions {
  startCursor?: number;
  /** Cursor moves only this long after the keys arrive (a slow repaint). */
  paintDelayMs?: number;
  /** DOWN/UP are swallowed: the cursor never lands. */
  stuck?: boolean;
  /** Text is swallowed: the field never paints it. */
  dropText?: boolean;
  /** Menu is not on screen at all. */
  noMenu?: boolean;
  /** The menu is up but no row carries the `❯` cursor (a render the parser cannot read). */
  noCursorMark?: boolean;
  /** The menu closes as soon as the first key arrives (Esc at the host keyboard). */
  closeOnFirstKeys?: boolean;
  /** The field paints half the text at once and the rest 10 ms later. */
  slowText?: boolean;
  onKeys?: (keys: string) => void;
}

function fakePty(o: FakePtyOptions = {}) {
  const real = ["Red", "Green", "Blue"];
  const rows = [...real, "Type something.", "Chat about this"];
  const typeRow = real.length;
  const state = {
    cursor: o.startCursor ?? 0,
    text: "",
    submitted: false,
    cursorAtTextWrite: -1,
    textAtEnter: "",
  };
  let menuClosed = false;
  const calls: string[] = [];
  const painted = { cursor: state.cursor };

  const lines = (): string[] => {
    if (o.noMenu || menuClosed) return ["❯ "];
    const out = ["Pick a colour?", ""];
    rows.forEach((label, i) => {
      const shown = i === typeRow && state.text ? state.text : label;
      out.push(`${i === painted.cursor && !o.noCursorMark ? "❯" : " "} ${i + 1}. ${shown}`);
    });
    out.push("", "Enter to select · ↑/↓ to navigate · Esc to cancel");
    return out;
  };

  const move = (delta: number) => {
    if (o.stuck) return;
    state.cursor = Math.max(0, Math.min(rows.length - 1, state.cursor + delta));
    const apply = () => {
      painted.cursor = state.cursor;
    };
    if (o.paintDelayMs) setTimeout(apply, o.paintDelayMs);
    else apply();
  };

  const pty = {
    hasSession: () => true,
    getOutputLines: async () => lines(),
    sendKeys: (_id: string, keys: string) => {
      calls.push(keys);
      o.onKeys?.(keys);
      if (o.closeOnFirstKeys) menuClosed = true;
      if (keys === "\r") {
        state.submitted = true;
        state.textAtEnter = state.text;
        return;
      }
      if (keys.startsWith(DOWN) || keys.startsWith(UP)) {
        // Plain navigation, possibly ending in Enter (the answer to a real row).
        move(keys.split(DOWN).length - keys.split(UP).length);
        if (keys.endsWith("\r")) state.submitted = true;
        return;
      }
      state.cursorAtTextWrite = painted.cursor;
      if (painted.cursor === typeRow && !o.dropText) {
        if (o.slowText) {
          state.text = keys.slice(0, Math.ceil(keys.length / 2));
          setTimeout(() => {
            state.text = keys;
          }, 10);
        } else state.text += keys;
      }
    },
  };
  return { pty, state, calls };
}

interface Harness {
  handlers: SessionHandlers;
  fake: ReturnType<typeof fakePty>;
  broadcasts: WSMessage[];
  pendingQuestions: SessionHandlersDeps["pendingQuestions"];
}

function harness(
  options: FakePtyOptions & { questions?: AskQuestion[]; timeoutMs?: number } = {},
): Harness {
  const fake = fakePty(options);
  const broadcasts: WSMessage[] = [];
  const pendingQuestions: SessionHandlersDeps["pendingQuestions"] = new Map([
    [
      SESSION,
      { toolUseId: TOOL_USE, questions: options.questions ?? [colour], origin: "jsonl" as const },
    ],
  ]);
  const deps = {
    pendingQuestions,
    pendingQuestionKey: new Map<string, string>([[SESSION, "key"]]),
    sessionSubscribers: new Map(),
    wsHub: {
      broadcast: (m: WSMessage) => broadcasts.push(m),
      broadcastToClients: (_c: unknown, m: WSMessage) => broadcasts.push(m),
    },
    ptyManager: fake.pty,
    textFieldTimeoutMs: options.timeoutMs ?? 400,
  };
  return {
    handlers: new SessionHandlers(deps as unknown as SessionHandlersDeps),
    fake,
    broadcasts,
    pendingQuestions,
  };
}

const request = (answers: unknown): IncomingMessage =>
  Readable.from([
    Buffer.from(JSON.stringify({ toolUseId: TOOL_USE, answers })),
  ]) as unknown as IncomingMessage;

function response() {
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

async function answer(h: Harness, answers: unknown) {
  const r = response();
  await h.handlers.handleSendAnswer(SESSION, request(answers), r.res);
  return { status: r.status(), body: r.body() };
}

const Q = colour.question;

describe("POST /answer — 'Chat about this'", () => {
  it("structured card: DOWN×(options+1) then Enter, in one write", async () => {
    const h = harness();
    const r = await answer(h, { [Q]: "Chat about this" });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(h.fake.calls).toEqual([`${DOWN.repeat(4)}\r`]);
    expect(h.fake.state.cursor).toBe(4);
    expect(h.pendingQuestions.has(SESSION)).toBe(false);
  });

  it("screen card (rows already in options): same keys, no duplicate rows", async () => {
    const scraped: AskQuestion = {
      ...colour,
      options: [...colour.options, option("Type something."), option("Chat about this")],
    };
    const h = harness({ questions: [scraped] });
    const r = await answer(h, { [Q]: "Chat about this" });
    expect(r.status).toBe(200);
    expect(h.fake.calls).toEqual([`${DOWN.repeat(4)}\r`]);
  });
});

describe("POST /answer — free text for 'Type something.'", () => {
  it("navigates, waits for the cursor, writes the text, then presses Enter alone", async () => {
    const h = harness({ paintDelayMs: 120 });
    const r = await answer(h, { [Q]: { other: "purple please" } });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(h.fake.calls).toEqual([DOWN.repeat(3), "purple please", "\r"]);
    // The text went in only after the screen showed the cursor on the row: a
    // handler that wrote straight after the keys would have found it on row 0.
    expect(h.fake.state.cursorAtTextWrite).toBe(3);
    expect(h.fake.state.text).toBe("purple please");
    expect(h.fake.state.submitted).toBe(true);
    expect(h.pendingQuestions.has(SESSION)).toBe(false);
    expect(h.broadcasts.some((m) => m.type === "question_cancelled")).toBe(true);
  });

  it("a multi-line answer reaches the field as Option+Enter newlines", async () => {
    const h = harness();
    const r = await answer(h, { [Q]: { other: "line one\nline two" } });
    expect(r.status).toBe(200);
    expect(h.fake.calls).toEqual([DOWN.repeat(3), "line one\x1b\rline two", "\r"]);
  });

  it("starts from where the cursor really is, so a retry after a failure lands too", async () => {
    const h = harness({ startCursor: 2 });
    const r = await answer(h, { [Q]: { other: "x" } });
    expect(r.status).toBe(200);
    expect(h.fake.calls).toEqual([DOWN, "x", "\r"]);
    const above = harness({ startCursor: 4 });
    await answer(above, { [Q]: { other: "x" } });
    expect(above.fake.calls).toEqual([UP, "x", "\r"]);
  });

  it("cursor never lands → 409 text_field_timeout, the text is not sent, the card stays", async () => {
    const h = harness({ stuck: true, timeoutMs: 150 });
    const r = await answer(h, { [Q]: { other: "never typed" } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, reason: "text_field_timeout" } });
    expect(h.fake.calls).toEqual([DOWN.repeat(3)]); // navigation only: no text, no Enter
    expect(h.fake.state.submitted).toBe(false);
    expect(h.pendingQuestions.has(SESSION)).toBe(true);
    expect(h.broadcasts.some((m) => m.type === "question_cancelled")).toBe(false);
  });

  it("text that never renders → 409 text_field_timeout and no Enter (Enter on an empty field declines)", async () => {
    const h = harness({ dropText: true, timeoutMs: 150 });
    const r = await answer(h, { [Q]: { other: "swallowed" } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, reason: "text_field_timeout" } });
    expect(h.fake.calls).not.toContain("\r");
    expect(h.fake.state.submitted).toBe(false);
    expect(h.pendingQuestions.has(SESSION)).toBe(true);
  });

  it("the card is replaced while waiting → 409 question_gone and the text is not sent", async () => {
    const h = harness({
      paintDelayMs: 100,
      onKeys: () => {
        h.pendingQuestions.set(SESSION, {
          toolUseId: "toolu_2",
          questions: [colour],
          origin: "jsonl" as const,
        });
      },
    });
    const r = await answer(h, { [Q]: { other: "for the old card" } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, reason: "question_gone" } });
    expect(h.fake.calls).toEqual([DOWN.repeat(3)]);
    expect(h.pendingQuestions.get(SESSION)?.toolUseId).toBe("toolu_2"); // not ours to clear
  });

  it("the card is replaced while the text is painting → 409 question_gone and no Enter", async () => {
    const h = harness({
      onKeys: (keys) => {
        if (keys === "for the old card") {
          h.pendingQuestions.set(SESSION, {
            toolUseId: "toolu_2",
            questions: [colour],
            origin: "jsonl" as const,
          });
        }
      },
    });
    const r = await answer(h, { [Q]: { other: "for the old card" } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, reason: "question_gone" } });
    expect(h.fake.calls).toEqual([DOWN.repeat(3), "for the old card"]); // never the Enter
    expect(h.pendingQuestions.get(SESSION)?.toolUseId).toBe("toolu_2");
  });

  it("a cursor the parser cannot read is assumed at the top: navigate from row 0, then time out", async () => {
    const h = harness({ noCursorMark: true, timeoutMs: 150 });
    const r = await answer(h, { [Q]: { other: "x" } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, reason: "text_field_timeout" } });
    expect(h.fake.calls).toEqual([DOWN.repeat(3)]);
  });

  it("the cursor is already on the row → no navigation keys, just the text and Enter", async () => {
    const h = harness({ startCursor: 3 });
    const r = await answer(h, { [Q]: { other: "x" } });
    expect(r.status).toBe(200);
    expect(h.fake.calls).toEqual(["x", "\r"]);
  });

  it("Enter waits until the text has finished painting, not just started", async () => {
    const h = harness({ slowText: true });
    const r = await answer(h, { [Q]: { other: "a full sentence here" } });
    expect(r.status).toBe(200);
    expect(h.fake.state.textAtEnter).toBe("a full sentence here");
  });

  it("the menu closes while waiting for the cursor → 409 question_gone, the card is cleared", async () => {
    const h = harness({ closeOnFirstKeys: true, timeoutMs: 150 });
    const r = await answer(h, { [Q]: { other: "too late" } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, reason: "question_gone" } });
    expect(h.fake.calls).toEqual([DOWN.repeat(3)]);
    expect(h.pendingQuestions.has(SESSION)).toBe(false);
    expect(h.broadcasts.some((m) => m.type === "question_cancelled")).toBe(true);
  });

  it("menu no longer on screen → 409 question_gone before any key", async () => {
    const h = harness({ noMenu: true });
    const r = await answer(h, { [Q]: { other: "late" } });
    expect(r).toMatchObject({ status: 409, body: { ok: false, reason: "question_gone" } });
    expect(h.fake.calls).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "  \n "],
    ["an escape sequence", "\x1b[B"],
    ["too long", "x".repeat(2001)],
  ])("%s → 400 invalid_text, zero bytes written", async (_n, other) => {
    const h = harness();
    const r = await answer(h, { [Q]: { other } });
    expect(r).toMatchObject({ status: 400, body: { ok: false, reason: "invalid_text" } });
    expect(h.fake.calls).toEqual([]);
    expect(h.pendingQuestions.has(SESSION)).toBe(true);
  });

  it("the bare label 'Type something.' → 400 unsupported_prompt_shape, zero bytes", async () => {
    const h = harness();
    const r = await answer(h, { [Q]: "Type something." });
    expect(r).toMatchObject({
      status: 400,
      body: { ok: false, reason: "unsupported_prompt_shape" },
    });
    expect(h.fake.calls).toEqual([]);
  });

  it("multi-select card → 400 unsupported_prompt_shape, zero bytes", async () => {
    const h = harness({ questions: [{ ...colour, multiSelect: true }] });
    const r = await answer(h, { [Q]: { other: "x" } });
    expect(r).toMatchObject({
      status: 400,
      body: { ok: false, reason: "unsupported_prompt_shape" },
    });
    expect(h.fake.calls).toEqual([]);
  });

  // Positive control: an ordinary label still answers through this very harness.
  it("a real option still answers with its keys", async () => {
    const h = harness();
    const r = await answer(h, { [Q]: "Blue" });
    expect(r.status).toBe(200);
    expect(h.fake.calls).toEqual([`${DOWN.repeat(2)}\r`]);
  });
});
