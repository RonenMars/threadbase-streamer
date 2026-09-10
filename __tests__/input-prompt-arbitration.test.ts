import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { CLAUDE_CODE_PROVIDER } from "../src/providers";
import { clearExpiredPendingPrompt } from "../src/server-wiring";
import { PromptRegistry } from "../src/services/prompts/promptRegistry";
import {
  detectGateScreen,
  permissionGateKey,
} from "../src/services/questions/detectPermissionGate";
import { detectShellPrompt } from "../src/services/questions/detectShellPrompt";
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
      // GATE carries options but no promptId, so arbitration asks the screen
      // about it (see the optionless-entry cases below). A gate is painted, so
      // every case built on this harness refuses for the reason it always did.
      hasSession: () => true,
      getOutputLines: async () => GATE_SCREEN,
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
  it.each(["permission", "question"] as const)(
    "clears an expired %s prompt and lets text input through",
    async (kind) => {
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
    },
  );

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

  it.each(["permission", "question"] as const)(
    "refuses with prompt_pending and writes zero bytes (%s)",
    async (kind) => {
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
    },
  );

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

// ---------------------------------------------------------------------------
// #703: an ANSWERED gate awaiting its close is not an open one.
//
// The accept path writes the keys and answers 200, but `pendingPermission`
// lives on until the detector sees the gate repaint away. Text in that window
// is still refused — the PTY cursor may still be on the picker — so the 409 and
// the zero write are unchanged. What was wrong is the wording: it told a user
// who had just answered to go answer the prompt.
//
// Every gate below comes from the REAL detector over rendered lines, fed
// through `handlePermissionChange` and answered through the real answer route.
// Nothing here hand-assembles a pending entry or a registry record.

const OPEN_WORDING = "A prompt is waiting for an answer; answer or dismiss it before sending text";
const ANSWERED_WORDING = "Your answer was sent; wait for the prompt to close before sending text";

const GATE_SCREEN = [
  "╭──────────────────────────────────────────────────────╮",
  "│ Bash command                                         │",
  "│                                                      │",
  "│ rm -rf /tmp/build-cache                              │",
  "│ Delete the stale build cache                         │",
  "│                                                      │",
  "│ Do you want to proceed?                              │",
  "│ ❯ 2. Yes                                             │",
  "│   3. No, and tell Claude what to do differently      │",
  "│                                                      │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain     │",
  "╰──────────────────────────────────────────────────────╯",
];

// Same gate, highlight moved one row down: a repaint, not a new instance.
// permissionContentKey includes the cursor so this is NOT an unchanged repaint
// and does rewrite the entry; permissionGateKey strips it so `samePrompt` holds
// and the entry keeps its promptId. That asymmetry is what test 3b pins.
const GATE_SCREEN_CURSOR_MOVED = GATE_SCREEN.map((l) =>
  l.startsWith("│ ❯ 2.")
    ? l.replace("│ ❯ 2.", "│   2.")
    : l.startsWith("│   3.")
      ? l.replace("│   3.", "│ ❯ 3.")
      : l,
);

// A different command: genuinely a new gate instance, not a repaint of this one.
const OTHER_GATE_SCREEN = GATE_SCREEN.map((l) =>
  l.includes("rm -rf /tmp/build-cache")
    ? "│ git push --force origin main                         │"
    : l,
);

// Box gone, prompt back — what the Claude scraper sees after a close.
const CLOSED_SCREEN = ["  Done.", "", "❯ ", "  accept edits on (shift+tab to cycle)"];

interface GateHarness {
  handlers: SessionHandlers;
  /** Text written to the PTY as composer input. */
  inputs: string[];
  /** Raw keys written to the PTY (the answer's option number, Esc, …). */
  written: string[];
  pendingPermission: SessionHandlersDeps["pendingPermission"];
  registry: PromptRegistry;
  /** What the freshness scrape sees; mutable so a screen can go stale mid-test. */
  screen: { lines: string[] };
  /** Feed a screen through the real detector + producer; returns the wire identity. */
  paint(lines: string[]): { contentKey: string; gateId: string };
  /** The detector's `gate === null` teardown. */
  close(): void;
  answer(id: { contentKey: string; gateId: string }): Promise<number>;
  send(body: Record<string, unknown>): Promise<{ status: number; body: any }>;
}

function gateHarness(): GateHarness {
  const inputs: string[] = [];
  const written: string[] = [];
  const broadcasts: WSMessage[] = [];
  const screen = { lines: GATE_SCREEN };
  const registry = new PromptRegistry();
  const pendingPermission: SessionHandlersDeps["pendingPermission"] = new Map();
  const deps = {
    checkSessionInputRateLimit: () => true,
    agentConfig: { enabled: false },
    idempotency: new IdempotencyStore(),
    promptRegistry: registry,
    pendingPermission,
    pendingPermissionKey: new Map<string, string>(),
    pendingQuestions: new Map(),
    pendingQuestionKey: new Map<string, string>(),
    sessionSubscribers: new Map(),
    sessionFileMap: new Map<string, string>(),
    ptyAttachedIds: () => new Set<string>(),
    log: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    wsHub: {
      broadcast: (m: WSMessage) => broadcasts.push(m),
      broadcastToClients: (_c: unknown, m: WSMessage) => broadcasts.push(m),
    },
    sessionStore: {
      get: () => null,
      updateManaged: () => {},
      getManaged: () => ({ provider: CLAUDE_CODE_PROVIDER }),
    },
    ptyManager: {
      hasSession: () => true,
      getOutputLines: async () => screen.lines,
      sendInput: (_id: string, input: string) => {
        inputs.push(input);
        return 1;
      },
      sendKeys: (_id: string, k: string) => {
        written.push(k);
      },
    },
  };
  const handlers = new SessionHandlers(deps as unknown as SessionHandlersDeps);

  return {
    handlers,
    inputs,
    written,
    pendingPermission,
    registry,
    screen,
    paint: (lines) => {
      const before = broadcasts.length;
      handlers.handlePermissionChange(SESSION, detectGateScreen(lines));
      const msg = broadcasts.slice(before).find((m) => m.type === "permission");
      if (msg?.type !== "permission") throw new Error("no permission broadcast");
      return { contentKey: msg.contentKey, gateId: msg.gateId };
    },
    close: () => handlers.handlePermissionChange(SESSION, null),
    answer: async (id) => {
      const { res, status } = response();
      await handlers.handlePermissionAnswer(
        SESSION,
        request({ contentKey: id.contentKey, optionIndex: 0, gateId: id.gateId }),
        res,
      );
      return status();
    },
    send: async (body) => {
      const { res, status, body: read } = response();
      await handlers.handleSendInput(SESSION, request(body), res);
      return { status: status(), body: read() };
    },
  };
}

/** Open a gate on screen and answer it: the window this issue is about. */
async function answeredWindow(): Promise<GateHarness> {
  const h = gateHarness();
  const gate = h.paint(GATE_SCREEN);
  expect(await h.answer(gate)).toBe(200);
  // The accept path wrote the option and left the entry standing for the
  // detector — that standing entry is the whole window under test.
  expect(h.written).toEqual(["2\r"]);
  expect(h.pendingPermission.has(SESSION)).toBe(true);
  return h;
}

describe("#703: POST /input { input } in the answered-gate window", () => {
  it("names an answered gate awaiting close and still writes zero bytes", async () => {
    const h = await answeredWindow();
    const { status, body } = await h.send({ input: "hello" });

    expect(status).toBe(409);
    expect(body).toEqual({
      ok: false,
      reason: "prompt_pending",
      promptKind: "permission",
      promptState: "answered",
      error: ANSWERED_WORDING,
    });
    // The refusal is unchanged in the only way that matters: nothing reached
    // the PTY. `written` still holds the answer's keys and nothing more.
    expect(h.inputs).toEqual([]);
    expect(h.written).toEqual(["2\r"]);
  });

  // Negative control. The same gate, the same request, sent BEFORE the answer:
  // the original wording, verbatim. This is what proves the branch above is
  // caused by the answer and not by the harness.
  it("keeps the open wording for text sent before the answer", async () => {
    const h = gateHarness();
    h.paint(GATE_SCREEN);
    const { status, body } = await h.send({ input: "hello" });

    expect(status).toBe(409);
    expect(body).toEqual({
      ok: false,
      reason: "prompt_pending",
      promptKind: "permission",
      promptState: "open",
      error: OPEN_WORDING,
    });
    expect(h.inputs).toEqual([]);
    expect(h.written).toEqual([]);
  });

  // Instance control, modelled on the Group C cross-version probe (1.69.6,
  // rows 2 and 5, observed twice): an accepted answer transiently mints a
  // FRESH gate — new gateId under the same content — before the real teardown.
  // That transient is a genuine new instance with its own open record, so
  // "open" is the CORRECT classification for those milliseconds. Asserted, not
  // "fixed".
  it("treats the transient gate minted after an answer as open", async () => {
    const h = await answeredWindow();
    const answered = h.pendingPermission.get(SESSION)?.gateId;

    h.close();
    const transient = h.paint(GATE_SCREEN);
    expect(transient.gateId).not.toBe(answered); // a new instance, not a repaint

    const during = await h.send({ input: "hello" });
    expect(during.status).toBe(409);
    expect(during.body).toMatchObject({ promptState: "open", error: OPEN_WORDING });
    expect(h.inputs).toEqual([]);

    // …and the transient's own cancel is the real teardown: text flows again.
    h.close();
    const after = await h.send({ input: "hello" });
    expect(after.status).toBe(200);
    expect(h.inputs).toEqual(["hello"]);
  });

  it("keeps answered across a cursor-move repaint", async () => {
    const h = await answeredWindow();
    const before = h.pendingPermission.get(SESSION)?.promptId;

    h.paint(GATE_SCREEN_CURSOR_MOVED);
    // Same instance: the entry was rewritten (the content key carries the
    // cursor) but kept its promptId, so the resolved record still answers for it.
    expect(h.pendingPermission.get(SESSION)?.promptId).toBe(before);

    const { status, body } = await h.send({ input: "hello" });
    expect(status).toBe(409);
    expect(body).toMatchObject({ promptState: "answered", error: ANSWERED_WORDING });
    expect(h.inputs).toEqual([]);
  });

  it("returns to open when the gate repaints with different content", async () => {
    const h = await answeredWindow();
    const before = h.pendingPermission.get(SESSION)?.promptId;

    h.paint(OTHER_GATE_SCREEN);
    expect(h.pendingPermission.get(SESSION)?.promptId).not.toBe(before);

    const { status, body } = await h.send({ input: "hello" });
    expect(status).toBe(409);
    expect(body).toMatchObject({ promptState: "open", error: OPEN_WORDING });
    expect(h.inputs).toEqual([]);
  });

  // Lifecycle + harness positive control: once the detector reports the gate
  // gone, the entry is cleared and the very same request is written. So the
  // empty `inputs` in every case above is a refusal, not a dead stub.
  it("clears the gate on the detector's close and writes the text", async () => {
    const h = await answeredWindow();
    h.close();
    expect(h.pendingPermission.has(SESSION)).toBe(false);

    const { status, body } = await h.send({ input: "hello" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(h.inputs).toEqual(["hello"]);
  });

  // Untouched: raw keys are the dismissal/navigation path and stay unarbitrated
  // in the answered window exactly as they are in the open one.
  it("does not arbitrate { keys } in the answered window", async () => {
    const h = await answeredWindow();
    const { status } = await h.send({ keys: "\x1b" });

    expect(status).toBe(200);
    expect(h.written).toEqual(["2\r", "\x1b"]);
    expect(h.inputs).toEqual([]);
  });

  // The predicate is `state === "resolved"`, not `state !== "open"`, and this is
  // why. When the freshness scrape fails because a DIFFERENT gate has taken the
  // screen before the detector announced it, permissionAnswerAdapter returns a
  // `cancelled` / `provider_closed` terminal and keeps the pending entry — that
  // entry is what keeps composer text off the live gate. So a cancelled record
  // sits beside a live entry, and that combination is a REFUSED answer with zero
  // bytes written. A widened predicate would tell the user their answer was sent
  // when it was not. (With no gate painted at all the adapter clears the entry,
  // like the legacy route's gateClosed() — see permission-adapter-closed-cleanup.)
  it("calls a cancelled-but-pending gate open, not answered", async () => {
    const h = gateHarness();
    h.paint(GATE_SCREEN);
    const promptId = h.pendingPermission.get(SESSION)?.promptId;
    if (!promptId) throw new Error("gate registered no prompt");
    const prompt = h.registry.get(promptId);
    if (!prompt) throw new Error("no prompt record");

    // A different gate takes the screen before the answer lands: freshness fails.
    h.screen.lines = OTHER_GATE_SCREEN;
    const answerRes = response();
    await h.handlers.handlePromptAnswer(
      SESSION,
      request({
        promptId,
        revision: prompt.revision,
        responses: [
          {
            questionId: prompt.questions[0].questionId,
            optionIds: [prompt.questions[0].options[0].optionId],
          },
        ],
        idempotencyKey: "idem-703-cancelled",
      }),
      answerRes.res,
    );

    // Refused, zero bytes, record cancelled — and the entry still standing.
    expect(answerRes.body()).toMatchObject({ ok: false, code: "prompt_cancelled" });
    expect(h.written).toEqual([]);
    expect(h.registry.get(promptId)?.state).toBe("cancelled");
    expect(h.pendingPermission.has(SESSION)).toBe(true);

    const { status, body } = await h.send({ input: "hello" });
    expect(status).toBe(409);
    expect(body).toMatchObject({ promptState: "open", error: OPEN_WORDING });
    expect(h.inputs).toEqual([]);
  });
});

// #757: pendingPermission/pendingQuestions can outlive the prompt record they
// were created for. A close via a route other than sweepExpired/the answer
// paths (e.g. prompt_not_found) never deletes the map entry, so it sits there
// until the registry's own terminal-retention window forgets the promptId.
// Only genuine absence from the registry means "gone" — a terminal-but-still-
// held record (the #703 window above) must keep refusing, since the picker
// may still be on screen.
describe("#757: a map entry outliving its registry record", () => {
  it.each(["permission", "question"] as const)(
    "accepts { input } once a %s record closed elsewhere is forgotten by the registry",
    async (kind) => {
      const h = harness(null);
      const deps = (h.handlers as unknown as { deps: SessionHandlersDeps }).deps;
      const registry = new PromptRegistry({ terminalRetentionMs: 10 });
      deps.promptRegistry = registry;
      const prompt = registry.open({
        sessionId: SESSION,
        intent: kind === "permission" ? "approval" : "question",
        message: "Allow command?",
        questions: [
          {
            text: "Allow command?",
            inputMode: "single",
            options: [{ label: "Yes" }, { label: "No" }],
            allowOther: false,
            secret: "unknown",
          },
        ],
        answerRequirement: "blocking",
        expiresAt: null,
        provenance: { source: "provider", confidence: "authoritative" },
      });
      if (kind === "permission") {
        h.pendingPermission.set(SESSION, {
          ...GATE,
          gateId: prompt.promptId,
          promptId: prompt.promptId,
        });
      } else {
        h.pendingQuestions.set(SESSION, {
          toolUseId: "toolu_1",
          questions: QUESTIONS,
          origin: "pty",
          promptId: prompt.promptId,
        });
      }

      // Closed by a route that never touches pendingPermission/pendingQuestions
      // (e.g. the mismatched-promptId branch in the answer adapters) — the map
      // entry is left standing exactly as the real defect describes.
      registry.transition(prompt.promptId, "cancelled", "provider_closed");
      // The registry's own retention window elapses, so `.get()` now forgets
      // the promptId entirely: genuinely gone, not just terminal.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registry.get(prompt.promptId)).toBeNull();

      const { res, status, body } = response();
      await h.handlers.handleSendInput(SESSION, request({ input: "hello" }), res);

      expect(status()).toBe(200);
      expect(body()).toEqual({ ok: true });
      expect(h.inputs).toEqual(["hello"]);
    },
  );

  // Positive control: a genuinely open record for the same session must keep
  // refusing exactly as before.
  it("keeps refusing while the registry record is still open", async () => {
    const h = harness(null);
    const deps = (h.handlers as unknown as { deps: SessionHandlersDeps }).deps;
    const registry = new PromptRegistry({ terminalRetentionMs: 10 });
    deps.promptRegistry = registry;
    const prompt = registry.open({
      sessionId: SESSION,
      intent: "question",
      message: "Which language?",
      questions: [
        {
          text: "Which language?",
          inputMode: "single",
          options: [{ label: "TypeScript" }, { label: "Rust" }],
          allowOther: false,
          secret: "unknown",
        },
      ],
      answerRequirement: "blocking",
      expiresAt: null,
      provenance: { source: "provider", confidence: "authoritative" },
    });
    h.pendingQuestions.set(SESSION, {
      toolUseId: "toolu_1",
      questions: QUESTIONS,
      origin: "pty",
      promptId: prompt.promptId,
    });

    const { res, status, body } = response();
    await h.handlers.handleSendInput(SESSION, request({ input: "hello" }), res);

    expect(status()).toBe(409);
    expect(body()).toMatchObject({ ok: false, reason: "prompt_pending", promptKind: "question" });
    expect(h.inputs).toEqual([]);
  });
});

// An optionless gate — the OSC 777 fired before the options painted — is stored
// with NO promptId and no registry record, so nothing sweeps or ages it and the
// registry-liveness test reads it as open forever. Reproduced: one
// `handlePermissionChange(sid, { options: [] })` refused every later /input with
// 409 prompt_pending, indefinitely. The rendered screen is now the authority for
// that entry, and only that entry.
describe("an optionless permission entry", () => {
  function optionlessHarness() {
    const h = gateHarness();
    const deps = (h.handlers as unknown as { deps: SessionHandlersDeps }).deps;
    const frames: WSMessage[] = [];
    deps.wsHub.broadcastToClients = (_clients, frame) => frames.push(frame);
    h.handlers.handlePermissionChange(SESSION, { options: [] });
    expect(h.pendingPermission.get(SESSION)?.promptId).toBeUndefined();
    return { h, deps, frames };
  }

  it("clears itself and lets text through once no gate is on screen", async () => {
    const { h, deps, frames } = optionlessHarness();
    h.screen.lines = CLOSED_SCREEN;

    const { status, body } = await h.send({ input: "hello" });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(h.inputs).toEqual(["hello"]);
    expect(h.pendingPermission.has(SESSION)).toBe(false);
    expect(deps.pendingPermissionKey.has(SESSION)).toBe(false);
    expect(frames).toContainEqual({ type: "permission_cancelled", sessionId: SESSION });
  });

  // The guard holds for the window arbitration exists for: a gate still painted.
  it("keeps refusing while a gate is still on screen", async () => {
    const { h, frames } = optionlessHarness();
    h.screen.lines = GATE_SCREEN;

    const { status, body } = await h.send({ input: "hello" });

    expect(status).toBe(409);
    expect(body).toMatchObject({ reason: "prompt_pending", promptState: "open" });
    expect(h.inputs).toEqual([]);
    expect(h.pendingPermission.has(SESSION)).toBe(true);
    expect(frames.some((f) => f.type === "permission_cancelled")).toBe(false);
  });

  // Best-effort in the refusing direction: no PTY to read is not proof of a clear screen.
  it("keeps refusing when there is no PTY to read", async () => {
    const { h, deps } = optionlessHarness();
    h.screen.lines = CLOSED_SCREEN;
    deps.ptyManager.hasSession = () => false;

    const { status } = await h.send({ input: "hello" });

    expect(status).toBe(409);
    expect(h.inputs).toEqual([]);
    expect(h.pendingPermission.has(SESSION)).toBe(true);
  });

  // Narrowness control: an entry WITH a live promptId never consults the screen,
  // so a stale screen read cannot unblock a registry-backed gate.
  it("leaves an entry with a live promptId to the registry, whatever the screen shows", async () => {
    const h = gateHarness();
    h.paint(GATE_SCREEN);
    h.screen.lines = CLOSED_SCREEN;

    const { status, body } = await h.send({ input: "hello" });

    expect(status).toBe(409);
    expect(body).toMatchObject({ reason: "prompt_pending", promptState: "open" });
    expect(h.inputs).toEqual([]);
    expect(h.pendingPermission.has(SESSION)).toBe(true);
  });
});

// tb-mobile #954: a card raised by detectShellPrompt (`read -p "[y/N]"`, a
// "press Enter") is never a Claude box. The answer routes' freshness check read
// only the box scraper, so every answer to one was refused as closed — and the
// "is any gate painted" check could not see one either, so a failed answer
// cleared the entry while the prompt was still up and composer text answered it.
const SHELL_FILLER = Array.from({ length: 20 }, (_, i) => `build step ${i} ok`);
const SHELL_SCREEN = [...SHELL_FILLER, "Overwrite existing config? [y/N]", ""];
const OTHER_SHELL_SCREEN = [...SHELL_FILLER, "Delete the build cache? [y/N]", ""];

describe("#954: shell-prompt gates and the freshness check", () => {
  function openShellGate(h: GateHarness, lines: string[]) {
    const gate = detectShellPrompt(lines);
    if (!gate) throw new Error("fixture is not a shell prompt");
    h.handlers.handlePermissionChange(SESSION, gate);
    const promptId = h.pendingPermission.get(SESSION)?.promptId;
    const prompt = promptId ? h.registry.get(promptId) : null;
    if (!prompt) throw new Error("shell gate registered no prompt");
    return { gate, prompt };
  }
  function answerFirstOption(prompt: NonNullable<ReturnType<PromptRegistry["get"]>>) {
    return request({
      promptId: prompt.promptId,
      revision: prompt.revision,
      responses: [
        {
          questionId: prompt.questions[0].questionId,
          optionIds: [prompt.questions[0].options[0].optionId],
        },
      ],
      idempotencyKey: `idem-954-${prompt.promptId}`,
    });
  }

  it("answers a still-painted shell prompt through the contract route", async () => {
    const h = gateHarness();
    h.screen.lines = SHELL_SCREEN;
    const { prompt } = openShellGate(h, SHELL_SCREEN);
    const r = response();
    await h.handlers.handlePromptAnswer(SESSION, answerFirstOption(prompt), r.res);

    expect(r.body()).toMatchObject({ ok: true });
    expect(h.written).toEqual(["y\r"]);
  });

  it("answers a still-painted shell prompt through the legacy route", async () => {
    const h = gateHarness();
    h.screen.lines = SHELL_SCREEN;
    const { gate } = openShellGate(h, SHELL_SCREEN);
    const r = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: permissionGateKey(gate), optionIndex: 0 }),
      r.res,
    );

    expect(r.body()).toMatchObject({ ok: true });
    expect(h.written).toEqual(["y\r"]);
  });

  it("keeps refusing composer text while a different shell prompt is painted", async () => {
    const h = gateHarness();
    const { prompt } = openShellGate(h, SHELL_SCREEN);
    // A different [y/N] took the screen before the answer landed.
    h.screen.lines = OTHER_SHELL_SCREEN;
    const r = response();
    await h.handlers.handlePromptAnswer(SESSION, answerFirstOption(prompt), r.res);

    expect(r.body()).toMatchObject({ ok: false, code: "prompt_cancelled" });
    expect(h.written).toEqual([]);
    expect(h.pendingPermission.has(SESSION)).toBe(true);
    const { status } = await h.send({ input: "yes please" });
    expect(status).toBe(409);
    expect(h.inputs).toEqual([]);
  });
});
