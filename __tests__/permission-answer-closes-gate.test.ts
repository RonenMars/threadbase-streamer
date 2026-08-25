import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { PTYManager } from "../src/pty-manager";
import type { WSMessage } from "../src/types";

// The seam between the two halves of the permission handshake, which each
// half's own tests cannot reach.
//
// POST /:id/permission/answer derives its keystrokes from `pendingPermission`
// — the HANDLER's map. The close that retires the gate reads
// `PTYManager.permissionOpen` — the RUNNER's map, and recognises the bytes via
// `isPermissionAnswer`. The route's unit tests mock `sendKeys`, so they stop at
// the handler's edge; the runner's tests call `sendKeys` directly, so they
// never involve the route.
//
// So what is untested is not "does isPermissionAnswer invert the route's
// expression" — it is whether BOTH MAPS HOLD THE SAME GATE at the moment the
// write happens. Nothing pins that invariant today; it holds because both are
// mutated in one synchronous chain, and it would break quietly the day either
// update became async.
//
// Quietly is the problem. If the close does not fire, no `permission_cancelled`
// reaches the client, and the card sits until its client-side expiry —
// degraded, not broken, invisible in casual testing. That event is the
// acceptance signal the whole handshake rests on.

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 12345,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const GATE_PAINT = [
  "╭────────────────────────────────────────────────────╮",
  "│ Bash command                                       │",
  "│   /opt/homebrew/bin/git reflog -8                  │",
  "│ This command requires approval                     │",
  "│                                                    │",
  "│ Do you want to proceed?                            │",
  "│ ❯ 1. Yes                                           │",
  "│   2. Yes, and don't ask again for: git reflog *    │",
  "│   3. No                                            │",
  "│                                                    │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain   │",
  "╰────────────────────────────────────────────────────╯",
].join("\r\n");

const settle = () => new Promise((r) => setTimeout(r, 10));

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

/** A real PTYManager wired to a real SessionHandlers, exactly as the server wires them. */
async function liveGate() {
  const broadcasts: WSMessage[] = [];
  const pendingPermission: SessionHandlersDeps["pendingPermission"] = new Map();
  const pendingPermissionKey = new Map<string, string>();

  let handlers!: SessionHandlers;
  const mgr = new PTYManager({
    onPermissionChange: (id, gate) => handlers.handlePermissionChange(id, gate),
  });
  handlers = new SessionHandlers({
    pendingPermission,
    pendingPermissionKey,
    sessionSubscribers: new Map(),
    // Provider unknown → Claude path (screen freshness), which this case pins.
    sessionStore: { getManaged: () => null },
    log: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    wsHub: {
      broadcast: (m: WSMessage) => broadcasts.push(m),
      broadcastToClients: (_c: unknown, m: WSMessage) => broadcasts.push(m),
    },
    ptyManager: mgr,
  } as unknown as SessionHandlersDeps);

  const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
  const proc = (mgr as any).sessions.get(session.id).process;

  proc._emit("data", GATE_PAINT);
  await settle();

  // Positive control. Every assertion below is void if the gate never opened,
  // and "no permission_cancelled" would read as a pass rather than as nothing
  // having happened at all.
  const opened = broadcasts.filter((m) => m.type === "permission");
  expect(opened).toHaveLength(1);
  const gate = pendingPermission.get(session.id);
  expect(gate?.options.map((o) => o.index)).toEqual([1, 2, 3]);
  expect((mgr as any).permissionOpen.get(session.id)).toBeDefined();

  const contentKey = (opened[0] as any).contentKey as string;
  broadcasts.length = 0;
  proc.write.mockClear();

  return { mgr, handlers, sessionId: session.id, proc, broadcasts, contentKey, gate };
}

describe("POST /permission/answer closes the gate it answered", () => {
  it("produces exactly one permission_cancelled — the close fires, and only once", async () => {
    const { handlers, sessionId, broadcasts, contentKey } = await liveGate();
    const { res, status, body } = response();

    await handlers.handlePermissionAnswer(sessionId, request({ contentKey, optionIndex: 0 }), res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
    // Not zero: the runner's close did not fire, so the client never learns the
    // gate is gone. Not two: both halves broadcast, and the client sees a
    // cancel for a card it may have already replaced.
    expect(broadcasts.filter((m) => m.type === "permission_cancelled")).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it("writes the keys the gate's own option declares, through a real sendKeys", async () => {
    const { handlers, sessionId, proc, contentKey, gate } = await liveGate();
    const { res } = response();

    await handlers.handlePermissionAnswer(sessionId, request({ contentKey, optionIndex: 0 }), res);

    // Anchored to the option the gate painted, not to a literal: if either the
    // route's derivation or the gate's shape changes, this breaks loudly.
    //
    // THE CLOSE IS DOWNSTREAM OF THIS DERIVATION. Getting it wrong — reading
    // optionIndex as the on-screen number rather than the array position, the
    // likeliest divergence between the server and the client — does not just
    // pick the wrong option. The bytes it produces are no longer bytes
    // `isPermissionAnswer` recognises, so the gate never closes and no
    // permission_cancelled is broadcast either. Two failures from one cause,
    // and only the first is visible: the user sees a wrong approval, and the
    // signal that would have told anyone is gone with it. Verified by mutating
    // this expression to permissionAnswerKeys(optionIndex), which turns three
    // of the four tests in this file red at once.
    const expected = `${gate?.options[0].index}\r`;
    expect(proc.write.mock.calls.map((c: unknown[]) => c[0])).toEqual([expected]);
    expect(expected).toBe("1\r"); // the gate paints 1/2/3, so position 0 is "1"
  });

  it("retires BOTH maps together, which is the invariant the close depends on", async () => {
    const { mgr, handlers, sessionId, contentKey } = await liveGate();
    const { res } = response();

    await handlers.handlePermissionAnswer(sessionId, request({ contentKey, optionIndex: 0 }), res);

    expect((mgr as any).permissionOpen.has(sessionId)).toBe(false);
    expect((handlers as any).deps.pendingPermission.has(sessionId)).toBe(false);
  });

  it("a refused answer reaches neither map nor the PTY", async () => {
    const { mgr, handlers, sessionId, proc, broadcasts } = await liveGate();
    const { res, status, body } = response();

    await handlers.handlePermissionAnswer(
      sessionId,
      request({ contentKey: "a key from some other gate", optionIndex: 0 }),
      res,
    );

    expect(status()).toBe(409);
    expect(body()).toEqual({ ok: false, reason: "gate_mismatch" });
    expect(proc.write.mock.calls).toEqual([]);
    expect(broadcasts).toEqual([]);
    // Still open on both sides — a refusal must not retire a live gate.
    expect((mgr as any).permissionOpen.has(sessionId)).toBe(true);
    expect((handlers as any).deps.pendingPermission.has(sessionId)).toBe(true);
  });
});
