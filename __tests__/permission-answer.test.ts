import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { CODEX_CLI_PROVIDER } from "../src/providers";
import { gateCard } from "../src/services/questions/codexScreen";
import { detectGateScreen } from "../src/services/questions/detectPermissionGate";
import type { WSMessage } from "../src/types";

// POST /api/sessions/:id/permission/answer — the validated permission route.
//
// Until it existed, a permission answer was raw bytes over POST /input, and
// `isPermissionAnswer` matched gates STRUCTURALLY only. Approval-gate shapes
// repeat constantly ("2. Yes / 3. No" for every tool call), so a delayed answer
// to gate A could match gate B and be written as B's answer: 200, no error, a
// normal permission_cancelled. A user who read a bash command and approved it
// could approve a different command they never saw.
//
// Every gate here is built by running the REAL detector (detectGateScreen) over
// rendered screen lines and feeding the result through handlePermissionChange,
// so the pending gate and its contentKey are produced exactly as production
// produces them — never hand-assembled.

const SESSION = "s1";

// A real Claude permission gate. The on-screen numbers are 2 and 3, NOT 1 and 2
// — that is the whole point of optionIndex being an array position: index 0
// here must answer "2\r".
const GATE_A_SCREEN = [
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

// Structurally IDENTICAL options, different command. This is the §3 hazard: the
// old path would have accepted A's answer against this screen.
const GATE_B_SCREEN = [
  "╭──────────────────────────────────────────────────────╮",
  "│ Bash command                                         │",
  "│                                                      │",
  "│ curl https://example.com/install.sh | sh             │",
  "│ Install the toolchain                                │",
  "│                                                      │",
  "│ Do you want to proceed?                              │",
  "│ ❯ 2. Yes                                             │",
  "│   3. No, and tell Claude what to do differently      │",
  "│                                                      │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain     │",
  "╰──────────────────────────────────────────────────────╯",
];

// The gate answered at the host keyboard: box gone, prompt back.
const CLOSED_SCREEN = [
  "  I've deleted the stale build cache.",
  "",
  "❯ ",
  "  accept edits on (shift+tab to cycle)",
];

interface Harness {
  handlers: SessionHandlers;
  written: string[];
  rawWritten: string[];
  broadcasts: WSMessage[];
  pendingPermission: SessionHandlersDeps["pendingPermission"];
  pendingPermissionKey: Map<string, string>;
  /** contentKey exactly as the client received it on the `permission` payload. */
  keyOf(screen: string[]): string;
}

/**
 * @param pendingScreen  screen the detector saw when the gate opened (null: no gate ever opened)
 * @param liveScreen     what the PTY renders NOW, when the answer arrives
 */
function harness(
  pendingScreen: string[] | null,
  liveScreen: string[],
  opts: { hasSession?: boolean; provider?: string } = {},
): Harness {
  const written: string[] = [];
  const rawWritten: string[] = [];
  const broadcasts: WSMessage[] = [];
  const pendingPermission: SessionHandlersDeps["pendingPermission"] = new Map();
  const pendingPermissionKey = new Map<string, string>();

  const deps = {
    pendingQuestions: new Map(),
    pendingQuestionKey: new Map(),
    pendingPermission,
    pendingPermissionKey,
    sessionSubscribers: new Map(),
    // Provider unknown → Claude path (screen freshness), which these cases pin.
    sessionStore: { getManaged: () => (opts.provider ? { provider: opts.provider } : null) },
    log: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    wsHub: {
      broadcast: (m: WSMessage) => broadcasts.push(m),
      broadcastToClients: (_c: unknown, m: WSMessage) => broadcasts.push(m),
    },
    ptyManager: {
      hasSession: () => opts.hasSession ?? true,
      getOutputLines: async () => liveScreen,
      sendKeys: (_id: string, keys: string) => written.push(keys),
      sendRawKeys: (_id: string, keys: string) => rawWritten.push(keys),
    },
  };
  const handlers = new SessionHandlers(deps as unknown as SessionHandlersDeps);

  // Populate the pending gate the way the PTY detector does.
  const keys = new Map<string, string>();
  const open = (screen: string[]): string => {
    const before = broadcasts.length;
    handlers.handlePermissionChange(SESSION, detectGateScreen(screen));
    const msg = broadcasts.slice(before).find((m) => m.type === "permission");
    if (!msg || !("contentKey" in msg)) throw new Error("no permission broadcast with contentKey");
    return msg.contentKey as string;
  };
  // Both keys are recorded from a real broadcast; only pendingScreen's gate is
  // left open (the other is opened, keyed, then cleared).
  for (const [name, screen] of [
    ["A", GATE_A_SCREEN],
    ["B", GATE_B_SCREEN],
  ] as const) {
    keys.set(name, open(screen));
    handlers.handlePermissionChange(SESSION, null);
  }
  broadcasts.length = 0;
  if (pendingScreen) handlers.handlePermissionChange(SESSION, detectGateScreen(pendingScreen));
  broadcasts.length = 0;

  return {
    handlers,
    written,
    rawWritten,
    broadcasts,
    pendingPermission,
    pendingPermissionKey,
    keyOf: (screen) => {
      const k = keys.get(screen === GATE_A_SCREEN ? "A" : "B");
      if (!k) throw new Error("unknown screen");
      return k;
    },
  };
}

function request(body: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
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

describe("permission payload carries contentKey", () => {
  it("emits contentKey on every gate broadcast", () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    expect(h.keyOf(GATE_A_SCREEN)).toEqual(expect.any(String));
  });

  it("gives two gates with different commands different keys", () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    expect(h.keyOf(GATE_A_SCREEN)).not.toBe(h.keyOf(GATE_B_SCREEN));
  });

  it("emits contentKey even for a gate whose options have not painted", () => {
    const h = harness(null, CLOSED_SCREEN);
    h.handlers.handlePermissionChange(SESSION, { options: [] });
    const msg = h.broadcasts.find((m) => m.type === "permission") as any;
    expect(msg.contentKey).toBe("::::::");
  });

  it("excludes the cursor, so moving the highlight does not change identity", () => {
    const moved = GATE_A_SCREEN.map((l) =>
      l.includes("2. Yes") ? l.replace("❯ 2. Yes", "  2. Yes") : l.replace("  3. No,", "❯ 3. No,"),
    );
    const a = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const b = harness(moved, moved);
    a.handlers.handlePermissionChange(SESSION, detectGateScreen(moved));
    const movedKey = (a.broadcasts.find((m) => m.type === "permission") as any).contentKey;
    expect(movedKey).toBe(b.keyOf(GATE_A_SCREEN));
  });
});

describe("POST /permission/answer — the gate is open and matches", () => {
  it("writes the ON-SCREEN number for the array position, not the position itself", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.written).toEqual(["2\r"]);
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
  });

  it("answers the second option with its own on-screen number", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 1 }),
      res,
    );

    expect(h.written).toEqual(["3\r"]);
    expect(status()).toBe(200);
  });

  it("does not broadcast — the PTY-side close owns that", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const { res } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.broadcasts).toEqual([]);
  });
});

describe("POST /permission/answer — gate_closed", () => {
  it("refuses when the gate closed at the host keyboard, writing NOTHING", async () => {
    const h = harness(GATE_A_SCREEN, CLOSED_SCREEN);
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "gate_closed" });
  });

  it("clears the pending gate and broadcasts permission_cancelled", async () => {
    const h = harness(GATE_A_SCREEN, CLOSED_SCREEN);
    const { res } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.pendingPermission.has(SESSION)).toBe(false);
    expect(h.pendingPermissionKey.has(SESSION)).toBe(false);
    expect(h.broadcasts).toEqual([{ type: "permission_cancelled", sessionId: SESSION }]);
  });

  it("refuses when no gate was ever open, and still tells the client", async () => {
    const h = harness(null, CLOSED_SCREEN);
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "gate_closed" });
    expect(h.broadcasts).toEqual([{ type: "permission_cancelled", sessionId: SESSION }]);
  });

  // THE defect. Our map still says gate A (the scrape is throttled ~300ms and
  // waits on the next PTY chunk); the screen already shows gate B, whose options
  // are byte-identical. A key check against the MAP alone passes here — only the
  // fresh scrape catches it.
  it("refuses when the map still says A but the screen has moved to B", async () => {
    const h = harness(GATE_A_SCREEN, GATE_B_SCREEN);
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "gate_closed" });
  });
});

describe("POST /raw-key — current permission gate", () => {
  it("refuses an open registry gate after the screen moved to another gate", async () => {
    const h = harness(GATE_A_SCREEN, GATE_B_SCREEN);
    const promptId = h.pendingPermission.get(SESSION)?.promptId;
    if (!promptId) throw new Error("expected pending permission prompt");
    const { res, status, body } = response();
    await h.handlers.handleRawKey(SESSION, request({ action: "down", promptId }), res);

    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, code: "raw_key_stale" });
    expect(h.rawWritten).toEqual([]);
    expect(h.pendingPermission.has(SESSION)).toBe(false);
  });
});

describe("POST /permission/answer — gate_mismatch", () => {
  it("refuses a stale answer aimed at a different gate", async () => {
    const h = harness(GATE_B_SCREEN, GATE_B_SCREEN);
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "gate_mismatch" });
  });

  // The open gate is on every client's screen. permission_cancelled is
  // session-wide, so broadcasting here would clear a LIVE card everywhere — and
  // pendingPermissionKey dedupe means the repaint that would restore it may
  // never come, because a gate is a waiting screen.
  it("leaves the live gate alone: no broadcast, still pending", async () => {
    const h = harness(GATE_B_SCREEN, GATE_B_SCREEN);
    const { res } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.broadcasts).toEqual([]);
    expect(h.pendingPermission.has(SESSION)).toBe(true);
    expect(h.pendingPermissionKey.get(SESSION)).toBeDefined();
  });
});

describe("POST /permission/answer — unknown_option", () => {
  it("refuses an index past the end of the options", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 2 }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "unknown_option" });
  });

  it("does not broadcast — the gate is still open and answerable", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const { res } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 2 }),
      res,
    );

    expect(h.broadcasts).toEqual([]);
    expect(h.pendingPermission.has(SESSION)).toBe(true);
  });

  it("refuses a gate whose options have not painted yet", async () => {
    const h = harness(null, GATE_A_SCREEN);
    h.handlers.handlePermissionChange(SESSION, { options: [] });
    h.broadcasts.length = 0;
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: "::::::", optionIndex: 0 }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "unknown_option" });
  });
});

describe("POST /permission/answer — malformed body", () => {
  it.each([
    ["missing contentKey", { optionIndex: 0 }],
    ["missing optionIndex", { contentKey: "k" }],
    ["non-string contentKey", { contentKey: 7, optionIndex: 0 }],
    ["non-integer optionIndex", { contentKey: "k", optionIndex: 1.5 }],
    ["negative optionIndex", { contentKey: "k", optionIndex: -1 }],
  ])("400s on %s without writing", async (_name, body) => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(SESSION, request(body), res);

    expect(h.written).toEqual([]);
    expect(status()).toBe(400);
  });
});

describe("POST /permission/answer — no PTY of ours to read", () => {
  it("still writes: an unowned session is not ours to veto", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN, { hasSession: false });
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0 }),
      res,
    );

    expect(h.written).toEqual(["2\r"]);
    expect(status()).toBe(200);
  });
});

// Issue #709. contentKey and gateId pin the gate; nothing pinned the option.
// optionIndex is a position in options[], but the frame also hands clients
// options[].index — the on-screen digit, 1-based. A client answering with the
// digit got a 200 and a DIFFERENT option of the same gate. optionLabel closes it.
const DONT_ASK_SCREEN = [
  "╭──────────────────────────────────────────────────────╮",
  "│ Bash command                                         │",
  "│                                                      │",
  "│ curl https://example.com/status                      │",
  "│ Check the service status                             │",
  "│                                                      │",
  "│ Do you want to proceed?                              │",
  "│ ❯ 1. Yes                                             │",
  "│   2. Yes, and don't ask again for: curl *            │",
  "│   3. No, and tell Claude what to do differently      │",
  "│                                                      │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain     │",
  "╰──────────────────────────────────────────────────────╯",
];

/** Open `gate` and return the `permission` frame exactly as a client gets it. */
function openGate(h: Harness, gate: Parameters<Harness["handlers"]["handlePermissionChange"]>[1]) {
  h.handlers.handlePermissionChange(SESSION, gate);
  const frame = h.broadcasts.find((m) => m.type === "permission") as any;
  h.broadcasts.length = 0;
  return frame as { contentKey: string; options: { index: number; label: string }[] };
}

describe("POST /permission/answer — optionLabel binds the option", () => {
  it("refuses a digit sent as a position, leaving the gate up and the PTY untouched", async () => {
    const h = harness(null, DONT_ASK_SCREEN);
    const frame = openGate(h, detectGateScreen(DONT_ASK_SCREEN));
    const yes = frame.options[0];
    expect(yes.label).toBe("Yes");
    const { res, status, body } = response();
    // on-screen digit of "Yes" (1) is the position of "don't ask again"
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: frame.contentKey, optionIndex: yes.index, optionLabel: yes.label }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "unknown_option" });
    expect(h.broadcasts).toEqual([]);
    expect(h.pendingPermission.has(SESSION)).toBe(true);
  });

  it("writes the intended option when position and label agree", async () => {
    const h = harness(null, DONT_ASK_SCREEN);
    const frame = openGate(h, detectGateScreen(DONT_ASK_SCREEN));
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: frame.contentKey, optionIndex: 0, optionLabel: "Yes" }),
      res,
    );

    expect(status()).toBe(200);
    expect(h.written).toEqual(["1\r"]);
  });

  it("trusts the position alone when optionLabel is absent (released clients)", async () => {
    const h = harness(null, DONT_ASK_SCREEN);
    const frame = openGate(h, detectGateScreen(DONT_ASK_SCREEN));
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: frame.contentKey, optionIndex: 1 }),
      res,
    );

    expect(status()).toBe(200);
    expect(h.written).toEqual(["2\r"]);
  });

  // Codex trust gate: digit 2 is "No, quit", position 2 is the persistent
  // "remember for all projects" grant. A refusal must not become a grant.
  it("refuses the Codex trust-gate inversion", async () => {
    const h = harness(null, CLOSED_SCREEN, { provider: CODEX_CLI_PROVIDER });
    const frame = openGate(h, gateCard("trust", []));
    const no = frame.options.find((o) => o.label === "No, quit");
    if (!no) throw new Error("expected a No, quit option");
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: frame.contentKey, optionIndex: no.index, optionLabel: no.label }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "unknown_option" });
    expect(h.pendingPermission.has(SESSION)).toBe(true);
  });

  it("400s on a non-string optionLabel without writing", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: h.keyOf(GATE_A_SCREEN), optionIndex: 0, optionLabel: 7 }),
      res,
    );

    expect(h.written).toEqual([]);
    expect(status()).toBe(400);
  });
});

// Escape used to be exempt from prompt binding: a card's Cancel was a blind
// "\x1b", so a Cancel whose gate had already closed landed at Claude's prompt
// and interrupted the turn the user was waiting on. Binding is now opt-in on
// the payload: a promptId makes Escape arbitrated like every other action,
// and no promptId keeps it exactly as blind as before.
describe("POST /raw-key — escape", () => {
  const registryOf = (h: Harness) =>
    (h.handlers as unknown as { deps: SessionHandlersDeps }).deps.promptRegistry;

  it("writes one Escape and retires the focused gate as cancelled", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const promptId = h.pendingPermission.get(SESSION)?.promptId;
    if (!promptId) throw new Error("expected pending permission prompt");
    const { res, status, body } = response();
    await h.handlers.handleRawKey(SESSION, request({ action: "escape", promptId }), res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(h.rawWritten).toEqual(["\x1b"]);
    expect(h.written).toEqual([]);
    expect(registryOf(h).get(promptId)).toMatchObject({
      state: "cancelled",
      terminalReason: "raw_key_escape",
    });
    expect(h.pendingPermission.has(SESSION)).toBe(false);
    // Cleared so a still-painted box (the Escape did not take) can re-show.
    expect(h.pendingPermissionKey.has(SESSION)).toBe(false);
    expect(h.broadcasts).toContainEqual({ type: "permission_cancelled", sessionId: SESSION });
  });

  it("refuses a bound Escape aimed at a prompt that is not focused, writing zero bytes", async () => {
    const h = harness(GATE_A_SCREEN, GATE_A_SCREEN);
    const promptId = h.pendingPermission.get(SESSION)?.promptId;
    const { res, status, body } = response();
    await h.handlers.handleRawKey(
      SESSION,
      request({ action: "escape", promptId: "a-gate-that-already-closed" }),
      res,
    );

    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, code: "raw_key_stale" });
    expect(h.rawWritten).toEqual([]);
    expect(h.written).toEqual([]);
    // The live gate is untouched.
    expect(h.pendingPermission.get(SESSION)?.promptId).toBe(promptId);
  });

  it("refuses a bound Escape once its gate has left the screen, writing zero bytes", async () => {
    const h = harness(GATE_A_SCREEN, CLOSED_SCREEN);
    const promptId = h.pendingPermission.get(SESSION)?.promptId;
    if (!promptId) throw new Error("expected pending permission prompt");
    const { res, status, body } = response();
    await h.handlers.handleRawKey(SESSION, request({ action: "escape", promptId }), res);

    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, code: "raw_key_stale" });
    expect(h.rawWritten).toEqual([]);
  });

  // Backward compatibility: the raw-keyboard Esc key and "interrupt the agent"
  // send no promptId and must keep reaching the PTY, gate or no gate.
  it.each([
    ["no gate open", null, CLOSED_SCREEN],
    ["a gate open", GATE_A_SCREEN, GATE_A_SCREEN],
  ] as const)("still writes an unbound Escape blindly with %s", async (_name, pending, live) => {
    const h = harness(pending as string[] | null, live as string[]);
    const before = h.pendingPermission.get(SESSION)?.promptId;
    const { res, status } = response();
    await h.handlers.handleRawKey(SESSION, request({ action: "escape" }), res);

    expect(status()).toBe(200);
    expect(h.rawWritten).toEqual(["\x1b"]);
    // Unbound means unarbitrated in both directions: nothing is retired either.
    expect(h.pendingPermission.get(SESSION)?.promptId).toBe(before);
  });
});
