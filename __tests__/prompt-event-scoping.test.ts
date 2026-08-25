import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { CLAUDE_CODE_PROVIDER } from "../src/providers";
import { detectGateScreen } from "../src/services/questions/detectPermissionGate";
import type { AskQuestion } from "../src/types";
import { WSHub } from "../src/ws-hub";

// Prompt lifecycle events carry prompt content (the command awaiting approval,
// the question and its options) and must reach ONLY the session's subscribers.
// They used to go through wsHub.broadcast(), i.e. to every authenticated
// socket on the server, subscribed to that session or not.
//
// Real WSHub, real SessionHandlers, gates from the real detector. Three fake
// sockets: A subscribed to the session, B connected but subscribed to nothing,
// C subscribed to a different session. Every case asserts A received the event
// (positive control — the path is exercised) and B and C received none of the
// four prompt event types.

const SESSION = "s1";
const OTHER = "s2";
const PROMPT_TYPES = new Set([
  "question",
  "permission",
  "question_cancelled",
  "permission_cancelled",
]);

const GATE_SCREEN = [
  "╭──────────────────────────────────────────────────────╮",
  "│ Bash command                                         │",
  "│                                                      │",
  "│ rm -rf /tmp/build-cache                              │",
  "│                                                      │",
  "│ Do you want to proceed?                              │",
  "│ ❯ 2. Yes                                             │",
  "│   3. No, and tell Claude what to do differently      │",
  "│                                                      │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain     │",
  "╰──────────────────────────────────────────────────────╯",
];

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

const MENU_OPEN = [
  "  Which language?",
  "❯ 1. TypeScript",
  "  2. Rust",
  "  Enter to select · ↑/↓ to navigate · Esc to cancel",
];
const MENU_CLOSED = ["  Done.", "", "❯ ", "  accept edits on (shift+tab to cycle)"];

type FakeSocket = WebSocket & { received: Array<{ type: string; sessionId?: string }> };

function fakeSocket(): FakeSocket {
  const received: FakeSocket["received"] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    received,
    send: (data: string) => received.push(JSON.parse(data)),
    on: () => {},
    ping: () => {},
    terminate: () => {},
  };
  return ws as unknown as FakeSocket;
}

const promptFrames = (ws: FakeSocket) => ws.received.filter((m) => PROMPT_TYPES.has(m.type));

interface Harness {
  handlers: SessionHandlers;
  a: FakeSocket;
  b: FakeSocket;
  c: FakeSocket;
  pendingQuestions: SessionHandlersDeps["pendingQuestions"];
  liveScreen: string[];
}

function harness(): Harness {
  const hub = new WSHub();
  const a = fakeSocket();
  const b = fakeSocket();
  const c = fakeSocket();
  for (const ws of [a, b, c]) hub.addClient(ws);
  const sessionSubscribers = new Map<string, Set<WebSocket>>([
    [SESSION, new Set([a])],
    [OTHER, new Set([c])],
  ]);
  const pendingQuestions: SessionHandlersDeps["pendingQuestions"] = new Map();
  const h: Harness = {
    handlers: undefined as unknown as SessionHandlers,
    a,
    b,
    c,
    pendingQuestions,
    liveScreen: MENU_OPEN,
  };
  const deps = {
    wsHub: hub,
    sessionSubscribers,
    pendingQuestions,
    pendingQuestionKey: new Map<string, string>(),
    pendingPermission: new Map(),
    pendingPermissionKey: new Map<string, string>(),
    sessionStore: { getManaged: () => ({ provider: CLAUDE_CODE_PROVIDER }) },
    log: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    ptyManager: {
      hasSession: () => true,
      getOutputLines: async () => h.liveScreen,
      sendKeys: () => {},
    },
  };
  h.handlers = new SessionHandlers(deps as unknown as SessionHandlersDeps);
  hub.dispose = () => {}; // fake sockets have nothing to terminate
  return h;
}

function request(body: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
}

function response(): ServerResponse {
  return { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;
}

function expectScoped(h: Harness, type: string): void {
  expect(h.a.received.map((m) => m.type)).toContain(type); // positive control
  expect(promptFrames(h.b)).toEqual([]);
  expect(promptFrames(h.c)).toEqual([]);
}

describe("prompt lifecycle events reach only the session's subscribers", () => {
  it("permission (gate opened)", () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    expectScoped(h, "permission");
    // The content that must not leak: the command awaiting approval.
    expect(JSON.stringify(h.b.received)).not.toContain("rm -rf");
    expect(JSON.stringify(h.c.received)).not.toContain("rm -rf");
  });

  it("permission_cancelled (gate closed by the PTY)", () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    h.handlers.handlePermissionChange(SESSION, null);
    expectScoped(h, "permission_cancelled");
  });

  it("permission_cancelled (answer route finds the gate closed)", async () => {
    const h = harness();
    h.handlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
    const gate = h.a.received.find((m) => m.type === "permission") as {
      contentKey: string;
      gateId: string;
    };
    h.liveScreen = MENU_CLOSED; // Claude scraper sees no gate → gate_closed
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: gate.contentKey, optionIndex: 0, gateId: gate.gateId }),
      response(),
    );
    expectScoped(h, "permission_cancelled");
  });

  it("question (live screen path)", () => {
    const h = harness();
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS);
    expectScoped(h, "question");
    expect(JSON.stringify(h.b.received)).not.toContain("Which language?");
  });

  it("question_cancelled (answered through the route)", async () => {
    const h = harness();
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS);
    const toolUseId = h.pendingQuestions.get(SESSION)?.toolUseId;
    await h.handlers.handleSendAnswer(
      SESSION,
      request({ toolUseId, answers: { "Which language?": "Rust" } }),
      response(),
    );
    expectScoped(h, "question_cancelled");
  });

  it("question_cancelled (answer route finds the menu gone)", async () => {
    const h = harness();
    h.handlers.handleLiveQuestion(SESSION, QUESTIONS);
    const toolUseId = h.pendingQuestions.get(SESSION)?.toolUseId;
    h.liveScreen = MENU_CLOSED;
    await h.handlers.handleSendAnswer(
      SESSION,
      request({ toolUseId, answers: { "Which language?": "Rust" } }),
      response(),
    );
    expectScoped(h, "question_cancelled");
  });

  // Negative control for the harness itself: a global broadcast DOES reach B
  // and C, so their silence above is scoping, not a dead socket.
  it("(control) a global broadcast still reaches every socket", () => {
    const h = harness();
    (h.handlers as unknown as { wsHub: WSHub }).wsHub.broadcast({ type: "ping", ts: 1 });
    expect(h.b.received.map((m) => m.type)).toEqual(["ping"]);
    expect(h.c.received.map((m) => m.type)).toEqual(["ping"]);
  });
});
