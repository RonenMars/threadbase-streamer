// Phase 6a of the live-sessions persistence plan: the protocol and runner seam
// for an out-of-process pty-host. Nothing wires this up yet — these tests are
// the only consumer, and exist so the contract is settled before PR 7's daemon
// depends on it.

import { describe, expect, it, vi } from "vitest";
import {
  encodeMessage,
  type HostEvent,
  type HostMessage,
  type HostRequest,
  type HostSession,
  isHostEvent,
  LineDecoder,
  PTY_HOST_PROTOCOL_VERSION,
  reviveSession,
} from "../src/pty-host/protocol";
import { RemoteSessionRunner } from "../src/pty-host/remote-session-runner";
import type { ManagedSession, PTYManagerOptions } from "../src/types";

const STARTED = new Date("2026-07-31T10:00:00Z");

function mkSession(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    provider: "claude-code",
    projectPath: "/repo",
    projectName: "repo",
    branch: "main",
    status: "running",
    startedAt: STARTED,
    completedAt: null,
    promptCount: 2,
    lastOutput: "",
    ...over,
  } as ManagedSession;
}

/**
 * An in-memory host. Answers requests with whatever the test registers and
 * records what it was sent, so the runner can be exercised without a socket.
 */
function mkHost(
  handlers: Partial<Record<HostRequest["type"], (req: HostRequest) => unknown>> = {},
) {
  const sent: HostRequest[] = [];
  let onLine: (line: string) => void = () => {};
  let onClose: () => void = () => {};

  const transport = {
    send(line: string) {
      const req = JSON.parse(line) as HostRequest;
      sent.push(req);
      const handler = handlers[req.type];
      // Deferred: a real transport never answers inside send(), and a runner
      // that only works when it does would deadlock on a real socket.
      queueMicrotask(() => {
        if (!handler) {
          onLine(encodeMessage({ id: req.id, ok: false, error: `unhandled: ${req.type}` }));
          return;
        }
        onLine(encodeMessage({ id: req.id, ok: true, result: handler(req) }));
      });
    },
    onLine(handler: (line: string) => void) {
      onLine = handler;
    },
    onClose(handler: () => void) {
      onClose = handler;
    },
    close: vi.fn(),
  };

  return {
    transport,
    sent,
    /** Push an unsolicited event, as the host would. */
    emit: (event: HostEvent) => onLine(encodeMessage(event)),
    /** Deliver a raw line, for framing and malformed-input tests. */
    deliver: (line: string) => onLine(line),
    drop: () => onClose(),
  };
}

const statusOf = (...sessions: HostSession[]) => ({
  protocolVersion: PTY_HOST_PROTOCOL_VERSION,
  sessions,
});

async function connect(
  handlers: Partial<Record<HostRequest["type"], (req: HostRequest) => unknown>> = {},
  options: PTYManagerOptions = {},
) {
  const host = mkHost({ subscribe: () => ({}), status: () => statusOf(), ...handlers });
  const runner = await RemoteSessionRunner.connect(host.transport, options);
  return { host, runner };
}

describe("LineDecoder", () => {
  it("reassembles a message split across chunks", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push("1}\n")).toEqual(['{"a":1}']);
  });

  it("returns several messages arriving in one chunk", () => {
    const decoder = new LineDecoder();
    expect(decoder.push("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });

  it("holds a trailing partial until its newline arrives", () => {
    const decoder = new LineDecoder();
    expect(decoder.push("done\npart")).toEqual(["done"]);
    expect(decoder.push("ial\n")).toEqual(["partial"]);
  });

  it("ignores empty lines rather than emitting them as messages", () => {
    expect(new LineDecoder().push("\n\na\n")).toEqual(["a"]);
  });
});

describe("reviveSession", () => {
  it("turns serialized dates back into Dates", () => {
    // The failure this prevents is silent: a string where a Date is expected
    // produces NaN elapsed times, and throws only at a distant .toISOString().
    const wire = JSON.parse(JSON.stringify(mkSession({ completedAt: STARTED })));
    const session = reviveSession(wire);

    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.startedAt.getTime()).toBe(STARTED.getTime());
    expect(session.completedAt).toBeInstanceOf(Date);
  });

  it("leaves a null date null", () => {
    expect(reviveSession(JSON.parse(JSON.stringify(mkSession()))).completedAt).toBeNull();
  });
});

describe("isHostEvent", () => {
  it("separates events from responses", () => {
    const event: HostMessage = { type: "event", event: "live-question-gone", sessionId: "s" };
    const response: HostMessage = { id: 1, ok: true, result: null };
    expect(isHostEvent(event)).toBe(true);
    expect(isHostEvent(response)).toBe(false);
  });
});

describe("RemoteSessionRunner — connect", () => {
  it("subscribes and seeds its mirror before answering anything", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 4242 }),
    });

    expect(host.sent.map((r) => r.type)).toEqual(["subscribe", "status"]);
    // The point of awaiting status: a runner handed out before this answers a
    // confident, wrong `false` for every session the host is holding.
    expect(runner.hasSession("sess-1")).toBe(true);
    expect(runner.getPid("sess-1")).toBe(4242);
    expect(runner.listSessions().map((s) => s.id)).toEqual(["sess-1"]);
  });

  it("revives dates coming through status", async () => {
    const { runner } = await connect({
      status: () =>
        JSON.parse(JSON.stringify(statusOf({ session: mkSession(), pid: 1 }))) as ReturnType<
          typeof statusOf
        >,
    });

    expect(runner.getSession("sess-1")?.startedAt).toBeInstanceOf(Date);
  });
});

describe("RemoteSessionRunner — spawn", () => {
  it("sends the session id for a resume and records the pid", async () => {
    const { host, runner } = await connect({
      spawn: () => ({ session: mkSession(), pid: 777 }) satisfies HostSession,
    });

    const session = await runner.start("sess-1", { projectPath: "/repo" });

    const spawn = host.sent.find((r) => r.type === "spawn");
    expect(spawn).toMatchObject({ sessionId: "sess-1", provider: "claude-code" });
    expect(session.id).toBe("sess-1");
    expect(session.startedAt).toBeInstanceOf(Date);
    // recordSessionSpawn reads this immediately; a null costs the next boot its
    // ability to probe whether the agent outlived us.
    expect(runner.getPid("sess-1")).toBe(777);
  });

  it("sends a null session id for startFresh — the host assigns one", async () => {
    const { host, runner } = await connect({
      spawn: () => ({ session: mkSession({ id: "host-assigned" }), pid: 5 }) satisfies HostSession,
    });

    const session = await runner.startFresh({ projectPath: "/repo" });

    expect(host.sent.find((r) => r.type === "spawn")).toMatchObject({ sessionId: null });
    expect(session.id).toBe("host-assigned");
    expect(runner.hasSession("host-assigned")).toBe(true);
  });

  it("rejects with the host's error rather than hanging", async () => {
    const { runner } = await connect();
    await expect(runner.start("sess-1", { projectPath: "/repo" })).rejects.toThrow(
      /unhandled: spawn/,
    );
  });
});

describe("RemoteSessionRunner — events", () => {
  it("forwards every PTYManagerOptions callback", async () => {
    const calls: string[] = [];
    const options: PTYManagerOptions = {
      onOutput: (id, data) => calls.push(`output:${id}:${data}`),
      onStatusChange: (s) => calls.push(`status:${s.status}`),
      onReady: (s) => calls.push(`ready:${s.id}`),
      onPermissionChange: (id, gate) =>
        calls.push(`gate:${id}:${gate === null ? "closed" : "open"}`),
      onLiveQuestion: (id, qs) => calls.push(`question:${id}:${qs.length}`),
      onLiveQuestionGone: (id) => calls.push(`question-gone:${id}`),
      onUserMessage: (id, text) => calls.push(`message:${id}:${text}`),
    };
    const { host } = await connect({}, options);

    host.emit({ type: "event", event: "output", sessionId: "s", data: "hi" });
    host.emit({ type: "event", event: "status-change", session: mkSession({ status: "idle" }) });
    host.emit({ type: "event", event: "ready", session: mkSession() });
    host.emit({ type: "event", event: "permission-change", sessionId: "s", gate: null });
    host.emit({ type: "event", event: "live-question", sessionId: "s", questions: [] as never[] });
    host.emit({ type: "event", event: "live-question-gone", sessionId: "s" });
    host.emit({ type: "event", event: "user-message", sessionId: "s", text: "go", ts: 1 });

    // The detectors run in the host, so a missing event here is a feature that
    // silently stops working once the flag is on — not a cosmetic gap.
    expect(calls).toEqual([
      "output:s:hi",
      "status:idle",
      "ready:sess-1",
      "gate:s:closed",
      "question:s:0",
      "question-gone:s",
      "message:s:go",
    ]);
  });

  it("accumulates output so getOutput stays synchronous", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 1 }),
    });

    host.emit({ type: "event", event: "output", sessionId: "sess-1", data: "one " });
    host.emit({ type: "event", event: "output", sessionId: "sess-1", data: "two" });

    expect(runner.getOutput("sess-1")).toBe("one two");
  });

  it("appends user messages to the input history mirror", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 1 }),
    });

    host.emit({ type: "event", event: "user-message", sessionId: "sess-1", text: "a", ts: 10 });
    host.emit({ type: "event", event: "user-message", sessionId: "sess-1", text: "b", ts: 20 });

    expect(runner.getInputHistory("sess-1")).toEqual([
      { text: "a", ts: 10 },
      { text: "b", ts: 20 },
    ]);
  });

  it("updates the mirror from a status-change", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession({ status: "running" }), pid: 1 }),
    });

    host.emit({
      type: "event",
      event: "status-change",
      session: mkSession({ status: "waiting_input" }),
    });

    expect(runner.getSession("sess-1")?.status).toBe("waiting_input");
  });

  it("drops a session from the mirror on exit", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 99 }),
    });

    host.emit({ type: "event", event: "exit", sessionId: "sess-1", exitCode: 0 });

    // Matches the in-process runners, whose handleExit deletes from their map —
    // which is what makes a gone session read as absent rather than idle.
    expect(runner.hasSession("sess-1")).toBe(false);
    expect(runner.getPid("sess-1")).toBeNull();
  });

  it("survives a malformed line without dropping the connection", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 1 }),
    });

    host.deliver("this is not json\n");
    host.emit({ type: "event", event: "output", sessionId: "sess-1", data: "still here" });

    expect(runner.getOutput("sess-1")).toBe("still here");
  });
});

describe("RemoteSessionRunner — synchronous methods", () => {
  it("sends input and advances promptCount optimistically", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession({ promptCount: 2 }), pid: 1 }),
      write: () => 3,
    });

    // Synchronous by interface, so it cannot await the host's authoritative
    // count; the next status-change corrects it.
    expect(runner.sendInput("sess-1", "hello")).toBe(3);
    expect(host.sent.find((r) => r.type === "write")).toMatchObject({ input: "hello" });
  });

  it("throws for an unknown session, exactly as an in-process runner does", async () => {
    const { runner } = await connect();
    expect(() => runner.sendInput("nope", "x")).toThrow(/Session not found/);
    expect(() => runner.getOutput("nope")).toThrow(/Session not found/);
  });

  it("maps putOnHold onto kill and forgets the session", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 1 }),
      kill: () => ({}),
    });

    runner.putOnHold("sess-1");

    expect(host.sent.find((r) => r.type === "kill")).toMatchObject({
      sessionId: "sess-1",
      hold: true,
    });
    expect(runner.hasSession("sess-1")).toBe(false);
  });

  it("maps killPid onto kill by pid", async () => {
    const { host, runner } = await connect({ kill: () => ({}) });
    runner.killPid(31337);
    expect(host.sent.find((r) => r.type === "kill")).toMatchObject({ pid: 31337 });
  });

  it("does not reject the process when a void-returning request fails", async () => {
    // sendKeys/cancel/killPid return void, so a rejected promise here would be
    // unhandled and take the process down over a keystroke that failed to land.
    const warn = vi.fn();
    const { runner } = await connect({}, { logger: { warn } as never });

    runner.cancel("sess-1");
    await new Promise((r) => setTimeout(r, 0));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("request failed"),
      expect.objectContaining({ type: "cancel" }),
    );
  });
});

describe("RemoteSessionRunner — async reads", () => {
  it("returns rendered lines and seeds the output mirror from replay", async () => {
    const { runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 1 }),
      replay: () => ({ lines: ["one", "two"], output: "raw bytes" }),
    });

    expect(await runner.getOutputLines("sess-1", 2)).toEqual(["one", "two"]);
    // A reconnecting streamer's getOutput must not be empty just because it
    // missed the output events that happened before it attached.
    expect(runner.getOutput("sess-1")).toBe("raw bytes");
  });

  it("hydrates input history for a session it did not start", async () => {
    const { runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 1 }),
      "input-history": () => ({ history: [{ text: "earlier", ts: 5 }] }),
    });

    expect(runner.getInputHistory("sess-1")).toEqual([]);
    expect(await runner.hydrateInputHistory("sess-1")).toEqual([{ text: "earlier", ts: 5 }]);
    expect(runner.getInputHistory("sess-1")).toEqual([{ text: "earlier", ts: 5 }]);
  });
});

describe("RemoteSessionRunner — connection loss", () => {
  it("fails in-flight requests instead of leaving them pending forever", async () => {
    const host = mkHost({ subscribe: () => ({}), status: () => statusOf() });
    const runner = await RemoteSessionRunner.connect(host.transport);

    const inFlight = runner.getOutputLines("sess-1", 10);
    host.drop();

    // A pending promise here is a hung session start, not an error the caller
    // can report.
    await expect(inFlight).rejects.toThrow(/connection closed/);
  });

  it("refuses new requests once closed", async () => {
    const host = mkHost({ subscribe: () => ({}), status: () => statusOf() });
    const runner = await RemoteSessionRunner.connect(host.transport);

    host.drop();

    await expect(runner.getOutputLines("sess-1", 10)).rejects.toThrow(/connection closed/);
  });

  it("dispose closes the connection without signalling the agents", async () => {
    const { host, runner } = await connect({
      status: () => statusOf({ session: mkSession(), pid: 1 }),
    });

    runner.dispose();

    // The whole point of the host is that its PTYs outlive the streamer, so
    // dispose must not become the in-process "signal every child".
    expect(host.transport.close).toHaveBeenCalled();
    expect(host.sent.some((r) => r.type === "kill")).toBe(false);
  });
});
