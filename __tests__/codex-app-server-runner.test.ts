import { readFileSync } from "fs";
import { join } from "path";
import type { AppServerTransport } from "../src/codex-app-server-client";
import { CodexAppServerRunner } from "../src/codex-app-server-runner";
import type { ManagedSession, SessionEvent } from "../src/types";

/**
 * Replays server lines captured from a real `codex app-server` (codex-cli
 * 0.166.0, sanitized by script: __tests__/fixtures/codex-app-server/0.166.0).
 * The fake answers each request by flushing the captured lines up to and
 * including that request's response, then any notifications that followed it
 * until the next response, exactly as the server ordered them.
 */
const FIXTURES = join(__dirname, "fixtures", "codex-app-server", "0.166.0");

class ReplayTransport implements AppServerTransport {
  pid: number | null = 4242;
  sent: any[] = [];
  killed: string | null = null;
  private lineCb: (l: string) => void = () => {};
  private exitCb: (c: number | null) => void = () => {};
  private cursor = 0;
  private lines: string[];
  constructor(fixture: string) {
    this.lines = readFileSync(join(FIXTURES, `${fixture}.jsonl`), "utf8")
      .trim()
      .split("\n");
  }
  write(line: string) {
    const msg = JSON.parse(line);
    this.sent.push(msg);
    if (msg.id === undefined || msg.method === undefined) return;
    setImmediate(() => {
      const isResponse = (l: string) => JSON.parse(l).method === undefined;
      // Emit through this request's response, then trailing notifications.
      while (this.cursor < this.lines.length) {
        const l = this.lines[this.cursor++];
        this.lineCb(l);
        if (isResponse(l) && JSON.parse(l).id === msg.id) break;
      }
      while (this.cursor < this.lines.length && !isResponse(this.lines[this.cursor])) {
        this.lineCb(this.lines[this.cursor++]);
      }
    });
  }
  emit(obj: unknown) {
    this.lineCb(JSON.stringify(obj));
  }
  onLine(cb: (l: string) => void) {
    this.lineCb = cb;
  }
  onExit(cb: (c: number | null) => void) {
    this.exitCb = cb;
  }
  kill(signal?: NodeJS.Signals) {
    this.killed = signal ?? "SIGTERM";
    this.exitCb(null);
  }
  crash(code: number) {
    this.exitCb(code);
  }
  methods() {
    return this.sent.map((m) => m.method);
  }
}

function build(fixture: string) {
  const transport = new ReplayTransport(fixture);
  const statuses: ManagedSession[] = [];
  const events: SessionEvent[] = [];
  const runner = new CodexAppServerRunner({
    onStatusChange: (s) => statuses.push({ ...s }),
    onSessionEvent: (_id, e) => events.push(e),
    spawnTransport: () => transport,
  } as any);
  return { runner, transport, statuses, events };
}

const opts = { projectPath: "/work/project" };
const THREAD = "00000000-0000-7000-8000-000000000001";
const step = (s: ManagedSession | undefined) => `${s?.status}/${s?.statusSource}`;

describe("CodexAppServerRunner", () => {
  it("starts a thread over the handshake and is waiting_input from an observed thread, not a timer", async () => {
    const { runner, transport } = build("ok");
    const session = await runner.startFresh(opts);
    expect(transport.methods()).toEqual(["initialize", "initialized", "thread/start"]);
    expect(transport.sent[2].params.cwd).toBe("/work/project");
    expect(session.id).toBe(THREAD);
    expect(session.provider).toBe("codex-cli");
    expect(session.status).toBe("waiting_input");
    expect(session.statusSource).toBe("thread-ready");
    expect(runner.getPid(THREAD)).toBe(4242);
  });

  it("enters running only on the observed turn/started, and waiting_input on turn/completed", async () => {
    const { runner, transport, statuses, events } = build("ok");
    await runner.startFresh(opts);
    const before = statuses.length;
    const promptCount = runner.sendInput(THREAD, "Reply with the single word: ok");
    expect(promptCount).toBe(1);
    // The turn/start request is sent, but sending is not an observation.
    await vi.waitFor(() => expect(transport.methods()).toContain("turn/start"));
    expect(transport.sent.at(-1).params).toEqual({
      threadId: THREAD,
      input: [{ type: "text", text: "Reply with the single word: ok" }],
    });
    expect(runner.getSession(THREAD)?.status).toBe("waiting_input");
    expect(statuses.length).toBe(before);

    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_completed")).toBe(true));
    expect(statuses.slice(before).map(step)).toEqual([
      "running/turn-signal",
      "waiting_input/turn-signal",
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "turn_started",
      "agent_message_delta",
      "agent_message",
      "turn_completed",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", status: "completed" });
    expect(events.find((e) => e.type === "agent_message")).toMatchObject({ text: "ok" });
    expect(runner.getSession(THREAD)?.lastOutput).toBe("ok");
    // The turn is over, so there is nothing to interrupt.
    runner.cancel(THREAD);
    expect(transport.methods()).not.toContain("turn/interrupt");
    expect(runner.getInputHistory(THREAD).map((m) => m.text)).toEqual([
      "Reply with the single word: ok",
    ]);
  });

  it("ignores retrying errors for status and ends a failed turn from turn/completed", async () => {
    const { runner, statuses, events } = build("noauth");
    await runner.startFresh(opts);
    const before = statuses.length;
    runner.sendInput(THREAD, "hello");
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_completed")).toBe(true));
    expect(statuses.slice(before).map(step)).toEqual([
      "running/turn-signal",
      "waiting_input/turn-signal",
    ]);
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThan(1);
    expect(errors.filter((e: any) => e.willRetry).length).toBe(errors.length - 1);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", status: "failed" });
    expect((events.at(-1) as any).error).toContain("401");
  });

  it("interrupts the active turn and settles on the interrupted status", async () => {
    const { runner, transport, statuses, events } = build("interrupt");
    await runner.startFresh(opts);
    runner.sendInput(THREAD, "count");
    await vi.waitFor(() => expect(events.some((e) => e.type === "agent_message_delta")).toBe(true));
    runner.cancel(THREAD);
    const interrupt = transport.sent.find((m) => m.method === "turn/interrupt");
    expect(interrupt.params.threadId).toBe(THREAD);
    expect(typeof interrupt.params.turnId).toBe("string");
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_completed")).toBe(true));
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", status: "interrupted" });
    expect(step(statuses.at(-1))).toBe("waiting_input/turn-signal");
  });

  it("does not end a turn on an inProgress turn/completed, and cancel with no turn sends nothing", async () => {
    const { runner, transport, statuses } = build("ok");
    await runner.startFresh(opts);
    runner.cancel(THREAD);
    expect(transport.methods()).not.toContain("turn/interrupt");
    transport.emit({
      method: "turn/started",
      params: { threadId: THREAD, turn: { id: "t", status: "inProgress" } },
    });
    transport.emit({
      method: "turn/completed",
      params: { threadId: THREAD, turn: { id: "t", status: "inProgress" } },
    });
    expect(step(statuses.at(-1))).toBe("running/turn-signal");
    // A repeated turn/started while already running is not a new transition.
    const count = statuses.length;
    transport.emit({
      method: "turn/started",
      params: { threadId: THREAD, turn: { id: "t2", status: "inProgress" } },
    });
    expect(statuses.length).toBe(count);
  });

  it("has no terminal, so key and resize calls are harmless no-ops", async () => {
    const { runner } = build("ok");
    await runner.startFresh(opts);
    expect(() => {
      runner.sendKeys();
      runner.sendRawKeys();
      runner.resize();
    }).not.toThrow();
    expect(runner.getOutput()).toBe("");
  });

  it("resumes by thread id", async () => {
    const { runner, transport } = build("resume");
    const session = await runner.start(THREAD, opts);
    expect(transport.methods()).toEqual(["initialize", "initialized", "thread/resume"]);
    expect(transport.sent[2].params.threadId).toBe(THREAD);
    expect(session.status).toBe("waiting_input");
  });

  it("resumes by resumeId when the session id differs", async () => {
    const { runner, transport } = build("resume");
    await runner.start("placeholder", { ...opts, resumeId: THREAD });
    expect(transport.sent[2].params.threadId).toBe(THREAD);
  });

  it("goes idle with process-exit when the app-server dies", async () => {
    const { runner, transport, statuses } = build("ok");
    await runner.startFresh(opts);
    transport.crash(1);
    expect(step(statuses.at(-1))).toBe("idle/process-exit");
    expect(runner.hasSession(THREAD)).toBe(false);
  });

  it("putOnHold kills the process and goes idle with shutdown", async () => {
    const { runner, transport, statuses } = build("ok");
    await runner.startFresh(opts);
    runner.putOnHold(THREAD);
    expect(transport.killed).toBe("SIGINT");
    expect(step(statuses.at(-1))).toBe("idle/shutdown");
    expect(statuses.filter((x) => x.status === "idle").length).toBe(1);
  });

  it("answers a server request with an error instead of leaving the turn waiting", async () => {
    const { runner, transport } = build("ok");
    await runner.startFresh(opts);
    transport.emit({ id: 77, method: "item/commandExecution/requestApproval", params: {} });
    const reply = transport.sent.find((m) => m.id === 77);
    expect(reply.error.code).toBe(-32601);
  });

  it("refuses additionalPaths, which it does not implement", async () => {
    const { runner } = build("ok");
    await expect(runner.startFresh({ ...opts, additionalPaths: ["/x"] })).rejects.toThrow(
      /additional/i,
    );
  });

  it("rejects input for an unknown session", () => {
    const { runner } = build("ok");
    expect(() => runner.sendInput("nope", "x")).toThrow(/not found/i);
  });
});
