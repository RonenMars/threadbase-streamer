import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
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
  opts: { hasSession?: boolean } = {},
): Harness {
  const written: string[] = [];
  const broadcasts: WSMessage[] = [];
  const pendingPermission: SessionHandlersDeps["pendingPermission"] = new Map();
  const pendingPermissionKey = new Map<string, string>();

  const deps = {
    pendingPermission,
    pendingPermissionKey,
    sessionSubscribers: new Map(),
    // Provider unknown → Claude path (screen freshness), which these cases pin.
    sessionStore: { getManaged: () => null },
    log: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    wsHub: { broadcast: (m: WSMessage) => broadcasts.push(m) },
    ptyManager: {
      hasSession: () => opts.hasSession ?? true,
      getOutputLines: async () => liveScreen,
      sendKeys: (_id: string, keys: string) => written.push(keys),
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
