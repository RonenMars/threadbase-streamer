// Issue #493, docs/observability-audit.md §3.2: catches that swallowed a failure
// with no trace. Each test pins the one structured line that now says so.
import { EventEmitter } from "events";
import { type ApiDepsWiring, createApiDeps } from "../src/server-wiring";
import { SessionWatchers, type SessionWatchersDeps } from "../src/session-watchers";
import { WSHub } from "../src/ws-hub";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any) =>
    h.calls.push({ level, msg, fields });
  const fake = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    log: () => {},
    pino: { isLevelEnabled: () => false },
  };
  return { getLogger: () => fake, logger: fake };
});

const eventsOf = (event: string) => h.calls.filter((c) => c.fields?.event === event);

beforeEach(() => {
  h.calls.length = 0;
});

// A plaintext socket whose send() throws, as ws does when it is not OPEN.
function throwingWs(): any {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    readyState: 1,
    OPEN: 1,
    send: () => {
      throw new Error("socket is gone");
    },
    terminate: () => {},
  });
}

describe("ws-hub plaintext send failure", () => {
  let hub: WSHub;
  beforeEach(() => {
    hub = new WSHub();
  });
  afterEach(() => hub.dispose());

  it("broadcast logs ws.send_failed once and drops the client", () => {
    const ws = throwingWs();
    hub.addClient(ws);
    hub.broadcast({ type: "cache_ready" } as any);
    hub.broadcast({ type: "cache_ready" } as any);

    const lines = eventsOf("ws.send_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].fields.error).toBe("socket is gone");
    expect(hub.connectionCount).toBe(0);
  });

  it("broadcastToClients keeps a failed subscriber quiet after the first line", () => {
    const ws = throwingWs();
    hub.addClient(ws);
    const subscribers = new Set([ws]);
    for (let i = 0; i < 3; i++) {
      hub.broadcastToClients(subscribers, { type: "cache_ready" } as any);
    }
    expect(eventsOf("ws.send_failed")).toHaveLength(1);
  });

  it("unicast logs ws.send_failed", () => {
    const ws = throwingWs();
    hub.addClient(ws);
    hub.unicast(ws, { type: "cache_ready" } as any);
    expect(eventsOf("ws.send_failed")).toHaveLength(1);
  });

  it("never logs the frame content", () => {
    const ws = throwingWs();
    hub.addClient(ws);
    hub.unicast(ws, { type: "terminal_output", sessionId: "s", data: "SECRET-PROMPT" } as any);
    expect(JSON.stringify(h.calls)).not.toContain("SECRET-PROMPT");
  });
});

describe("SessionWatchers.watchConversationFile", () => {
  it("logs session.conversation_watch_failed when the JSONL lookup rejects", async () => {
    const watchers = new SessionWatchers({
      findConversationByUuid: async () => {
        throw new Error("lookup exploded");
      },
      sessionFileMap: new Map(),
      fileWatcher: { watch: () => {} },
    } as unknown as SessionWatchersDeps);

    await expect(watchers.watchConversationFile("sess-1", "hist-1")).resolves.toBeUndefined();

    const lines = eventsOf("session.conversation_watch_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].fields).toMatchObject({
      sessionId: "sess-1",
      historyId: "hist-1",
      error: "lookup exploded",
    });
  });
});

describe("handleWsMessage malformed JSON", () => {
  it("logs ws.malformed_message at debug with the size only", async () => {
    const fake = {
      debug: (msg: string, fields: any) => h.calls.push({ level: "debug", msg, fields }),
      warn: () => {},
    };
    const deps = createApiDeps({
      wsHub: { receive: (_ws: unknown, raw: unknown) => raw },
      log: () => fake,
    } as unknown as ApiDepsWiring);

    await deps.handleWsMessage({} as any, "{not json SECRET-PROMPT", null);

    const lines = eventsOf("ws.malformed_message");
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("debug");
    expect(lines[0].fields.bytes).toBe("{not json SECRET-PROMPT".length);
    expect(JSON.stringify(h.calls)).not.toContain("SECRET-PROMPT");
  });
});

describe("ws-hub dispose terminate failure", () => {
  it("logs ws.terminate_failed when a client refuses to terminate", () => {
    const hub = new WSHub();
    const emitter = new EventEmitter();
    const ws = Object.assign(emitter, {
      readyState: 1,
      OPEN: 1,
      send: () => {},
      terminate: () => {
        throw new Error("already gone");
      },
    });
    hub.addClient(ws as any);
    hub.dispose();

    const lines = eventsOf("ws.terminate_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].fields.error).toBe("already gone");
    expect(hub.connectionCount).toBe(0);
  });
});
