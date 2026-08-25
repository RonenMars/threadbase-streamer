import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER, type ProviderName } from "../src/providers";
import { type ApiDepsWiring, createApiDeps } from "../src/server-wiring";
import { detectCodexCommandApproval } from "../src/services/questions/codexScreen";
import { detectGateScreen } from "../src/services/questions/detectPermissionGate";
import type { WSMessage } from "../src/types";

// Permission gate identity (D9) and provider-aware answer freshness.
//
// contentKey is content-derived: it distinguishes gates with different
// prompt/detail/options, NOT two consecutive gates whose content is identical.
// Approval gates repeat constantly, so a delayed answer to gate A could be
// written as identical gate B's answer. gateId is a server-owned instance id
// minted by handlePermissionChange; the answer route refuses a stale one.
//
// Freshness used to run the Claude box scraper for every provider. A Codex
// screen never matches it, so every Codex answer through the route was refused
// as gate_closed — and the card was cancelled on every client as a side effect.
//
// Every gate here comes from a REAL detector over rendered lines, fed through
// handlePermissionChange, never hand-assembled.

const SESSION = "s1";

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

// Same gate, highlight moved to the second row: a repaint, not a new instance.
const GATE_SCREEN_CURSOR_MOVED = GATE_SCREEN.map((l) =>
  l.startsWith("│ ❯ 2.")
    ? l.replace("│ ❯ 2.", "│   2.")
    : l.startsWith("│   3.")
      ? l.replace("│   3.", "│ ❯ 3.")
      : l,
);

// Box gone, prompt back — what the Claude scraper sees after a close.
const CLOSED_SCREEN = ["  Done.", "", "❯ ", "  accept edits on (shift+tab to cycle)"];

// A real Codex EXEC card (fixture from codex-pty-runner.test.ts). The Claude
// box scraper returns null for this screen.
const CODEX_EXEC_SCREEN = [
  "E X E C",
  "Environment: local",
  "Reason: Run the focused test suite",
  "$ npx vitest run __tests__/codex-pty-runner.test.ts",
  "› 1. Yes",
  "  2. No",
  "Press Enter to confirm",
];

type Gate = Parameters<SessionHandlers["handlePermissionChange"]>[1];

interface Harness {
  handlers: SessionHandlers;
  written: string[];
  broadcasts: WSMessage[];
  events: string[];
  pendingPermission: SessionHandlersDeps["pendingPermission"];
  /** Feed a gate through the real producer path; returns the broadcast identity. */
  open(gate: Gate): { contentKey: string; gateId: string };
  close(): void;
}

function harness(opts: { provider: ProviderName | null; liveScreen: string[] }): Harness {
  const written: string[] = [];
  const broadcasts: WSMessage[] = [];
  const events: string[] = [];
  const pendingPermission: SessionHandlersDeps["pendingPermission"] = new Map();
  const record = (_m: string, f?: Record<string, unknown>) => {
    if (typeof f?.event === "string") events.push(f.event);
  };
  const deps = {
    pendingPermission,
    pendingPermissionKey: new Map<string, string>(),
    sessionSubscribers: new Map(),
    sessionStore: { getManaged: () => (opts.provider ? { provider: opts.provider } : null) },
    log: () => ({ info: record, warn: record, debug: record }),
    wsHub: { broadcast: (m: WSMessage) => broadcasts.push(m) },
    ptyManager: {
      hasSession: () => true,
      getOutputLines: async () => opts.liveScreen,
      sendKeys: (_id: string, keys: string) => written.push(keys),
    },
  };
  const handlers = new SessionHandlers(deps as unknown as SessionHandlersDeps);
  return {
    handlers,
    written,
    broadcasts,
    events,
    pendingPermission,
    open: (gate) => {
      const before = broadcasts.length;
      handlers.handlePermissionChange(SESSION, gate);
      const msg = broadcasts.slice(before).find((m) => m.type === "permission");
      if (msg?.type !== "permission") throw new Error("no permission broadcast");
      return { contentKey: msg.contentKey, gateId: msg.gateId };
    },
    close: () => handlers.handlePermissionChange(SESSION, null),
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

const claudeGate = (screen: string[]): Gate => detectGateScreen(screen);

describe("gateId on the wire", () => {
  it("every permission broadcast carries a non-empty gateId", () => {
    const h = harness({ provider: CLAUDE_CODE_PROVIDER, liveScreen: GATE_SCREEN });
    const { gateId } = h.open(claudeGate(GATE_SCREEN));
    expect(typeof gateId).toBe("string");
    expect(gateId.length).toBeGreaterThan(0);
  });

  it("a cursor-move repaint keeps the gateId (same instance)", () => {
    const h = harness({ provider: CLAUDE_CODE_PROVIDER, liveScreen: GATE_SCREEN });
    const a = h.open(claudeGate(GATE_SCREEN));
    const b = h.open(claudeGate(GATE_SCREEN_CURSOR_MOVED));
    expect(b.contentKey).toBe(a.contentKey);
    expect(b.gateId).toBe(a.gateId);
  });

  it("a close and content-identical reopen mints a NEW gateId under the SAME contentKey", () => {
    const h = harness({ provider: CLAUDE_CODE_PROVIDER, liveScreen: GATE_SCREEN });
    const a = h.open(claudeGate(GATE_SCREEN));
    h.close();
    const b = h.open(claudeGate(GATE_SCREEN));
    expect(b.contentKey).toBe(a.contentKey); // content identity cannot tell them apart…
    expect(b.gateId).not.toBe(a.gateId); // …the instance id can
  });
});

describe("D9: an answer to gate A cannot settle identical gate B", () => {
  function twoIdenticalGates() {
    const h = harness({ provider: CLAUDE_CODE_PROVIDER, liveScreen: GATE_SCREEN });
    const a = h.open(claudeGate(GATE_SCREEN));
    h.close();
    const b = h.open(claudeGate(GATE_SCREEN));
    h.broadcasts.length = 0;
    return { h, a, b };
  }

  it("refuses A's gateId against B: 409 gate_mismatch, zero bytes, B still open", async () => {
    const { h, a, b } = twoIdenticalGates();
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: b.contentKey, optionIndex: 0, gateId: a.gateId }),
      res,
    );
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "gate_mismatch" });
    expect(h.written).toEqual([]);
    expect(h.pendingPermission.get(SESSION)?.gateId).toBe(b.gateId);
    expect(h.broadcasts.some((m) => m.type === "permission_cancelled")).toBe(false);
  });

  // Positive control: the identical request with B's own id is accepted and
  // writes the on-screen number — so the refusal above is the id check.
  it("accepts B's gateId against B and writes the on-screen number", async () => {
    const { h, b } = twoIdenticalGates();
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: b.contentKey, optionIndex: 0, gateId: b.gateId }),
      res,
    );
    expect(status()).toBe(200);
    expect(h.written).toEqual(["2\r"]);
    expect(h.events).not.toContain("permission.answer_legacy_identity");
  });

  it("legacy client without gateId still answers on contentKey, and is logged as legacy", async () => {
    const { h, b } = twoIdenticalGates();
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: b.contentKey, optionIndex: 0 }),
      res,
    );
    expect(status()).toBe(200);
    expect(h.written).toEqual(["2\r"]);
    expect(h.events).toContain("permission.answer_legacy_identity");
  });

  it("rejects a non-string gateId before touching anything", async () => {
    const { h, b } = twoIdenticalGates();
    const { res, status } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: b.contentKey, optionIndex: 0, gateId: 5 }),
      res,
    );
    expect(status()).toBe(400);
    expect(h.written).toEqual([]);
  });
});

describe("provider-aware freshness: Codex answers no longer hit the Claude scraper", () => {
  const codexGate = (): Gate => detectCodexCommandApproval(CODEX_EXEC_SCREEN);

  it("answers a Codex EXEC card and writes its literal answerKeys", async () => {
    const h = harness({ provider: CODEX_CLI_PROVIDER, liveScreen: CODEX_EXEC_SCREEN });
    const g = h.open(codexGate());
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: g.contentKey, optionIndex: 0, gateId: g.gateId }),
      res,
    );
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(h.written).toEqual(["y"]);
    expect(h.pendingPermission.has(SESSION)).toBe(true); // PTY-side close owns the clear
  });

  // Negative control: the very same card and screen under the Claude provider
  // is refused — the Claude scraper cannot see a Codex screen — so the success
  // above is caused by the provider check, not by the screen happening to match.
  it("the same card under the Claude provider is refused as gate_closed", async () => {
    const h = harness({ provider: CLAUDE_CODE_PROVIDER, liveScreen: CODEX_EXEC_SCREEN });
    const g = h.open(codexGate());
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: g.contentKey, optionIndex: 0, gateId: g.gateId }),
      res,
    );
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "gate_closed" });
    expect(h.written).toEqual([]);
  });

  it("Claude freshness is unchanged: a closed screen still refuses", async () => {
    const h = harness({ provider: CLAUDE_CODE_PROVIDER, liveScreen: CLOSED_SCREEN });
    const g = h.open(claudeGate(GATE_SCREEN));
    const { res, status, body } = response();
    await h.handlers.handlePermissionAnswer(
      SESSION,
      request({ contentKey: g.contentKey, optionIndex: 0, gateId: g.gateId }),
      res,
    );
    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "gate_closed" });
    expect(h.written).toEqual([]);
  });
});

describe("subscribe replay carries the pending gate's gateId", () => {
  // A gate that opened before the client subscribed is replayed from the
  // pending map; the replay must carry the same instance id the live broadcast
  // would have, or a late subscriber could never answer.
  it("replays gateId alongside contentKey", async () => {
    const h = harness({ provider: CLAUDE_CODE_PROVIDER, liveScreen: GATE_SCREEN });
    const live = h.open(claudeGate(GATE_SCREEN));

    const sent: string[] = [];
    const ws = { send: (data: string) => sent.push(data) } as unknown as WebSocket;
    const { handleWsMessage } = createApiDeps({
      addSessionSubscriber: vi.fn(),
      removeSessionSubscriber: vi.fn(),
      wsToClientId: new Map(),
      clientIdToWs: new Map(),
      sessionSubscribers: new Map(),
      terminalSeq: new Map(),
      pendingPermission: h.pendingPermission,
      pendingQuestions: new Map(),
      // No live PTY: skips terminal_replay and goes straight to pending state.
      ptyManager: { hasSession: () => false },
      log: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
    } as unknown as ApiDepsWiring);

    handleWsMessage(ws, JSON.stringify({ type: "subscribe_session", sessionId: SESSION }), null);
    await new Promise((r) => setTimeout(r, 20));

    const replay = sent.map((s) => JSON.parse(s)).find((m) => m.type === "permission");
    expect(replay).toBeDefined();
    expect(replay.contentKey).toBe(live.contentKey);
    expect(replay.gateId).toBe(live.gateId);
  });
});
