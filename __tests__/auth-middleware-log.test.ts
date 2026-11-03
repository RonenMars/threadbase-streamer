import type { Context, Next } from "hono";

/**
 * The auth middleware's decision is logged (#486): a refusal at warn, every
 * accepting branch at debug, never with a credential or a query string.
 *
 * Drives the middleware directly; the logger and the relay probe are mocked in
 * this file only, so the rest of the suite keeps the real ones.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any; dest: unknown }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any, dest: unknown) =>
    h.calls.push({ level, msg, fields, dest });
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

vi.mock("../src/relay/ingress", () => ({
  isViaRelay: (socket: { relay?: boolean } | undefined) => socket?.relay === true,
}));

const { authMiddleware } = await import("../src/api/middleware/auth.middleware");

const API_KEY = "tb_0123456789abcdef0123456789abcdef";
const BAD_BEARER = "tb_badbearer00000000000000000000aa";
const SECRET_QUERY = "SECRET_QUERY_VALUE_9f3a";
const TUNNEL_IP = "203.0.113.9";

function run(opts: {
  localNoAuth?: boolean;
  remoteAddress?: string;
  host?: string;
  path?: string;
  method?: string;
  query?: string;
  headers?: Record<string, string>;
  relay?: boolean;
}) {
  const headers: Record<string, string> = {
    host: opts.host ?? "127.0.0.1:8766",
    ...opts.headers,
  };
  const search = opts.query ? `?key=${opts.query}` : "";
  let status: number | undefined;
  let nexts = 0;
  const c = {
    req: {
      url: `http://127.0.0.1:8766${opts.path ?? "/api/devices"}${search}`,
      method: opts.method ?? "GET",
      header: (name: string) => headers[name.toLowerCase()],
      query: (name: string) => (name === "key" ? opts.query : undefined),
    },
    env: {
      incoming: {
        socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1", relay: opts.relay },
      },
    },
    json: (_body: unknown, code: number) => {
      status = code;
      return undefined as unknown as Response;
    },
    set: () => {},
  } as unknown as Context;
  const next: Next = async () => {
    nexts += 1;
  };
  const mw = authMiddleware({
    apiKey: API_KEY,
    localNoAuth: opts.localNoAuth ?? false,
    devicesRepo: () => null,
  } as unknown as Parameters<typeof authMiddleware>[0]);
  return mw(c, next).then(() => ({ status, nexts }));
}

const at = (level: string) => h.calls.filter((c) => c.level === level);
const everything = () => JSON.stringify(h.calls);

beforeEach(() => {
  h.calls.length = 0;
});

describe("a rejected request logs one warn with exactly the four fields", () => {
  it("no credential", async () => {
    const r = await run({ path: "/api/devices", method: "POST", remoteAddress: "127.0.0.1" });

    expect(r.status).toBe(401);
    expect(at("warn")).toHaveLength(1);
    expect(at("warn")[0].fields).toEqual({
      event: "auth.rejected",
      path: "/api/devices",
      method: "POST",
      remoteAddr: "127.0.0.1",
    });
  });

  it("wrong bearer plus ?key= never leaks either value, nor the query string", async () => {
    const r = await run({
      headers: { authorization: `Bearer ${BAD_BEARER}`, cookie: "session=COOKIE_VALUE" },
      query: SECRET_QUERY,
      remoteAddress: "198.51.100.7",
      host: "api.example.com",
    });

    expect(r.status).toBe(401);
    expect(at("warn")[0].fields).toEqual({
      event: "auth.rejected",
      path: "/api/devices",
      method: "GET",
      remoteAddr: "198.51.100.7",
    });
    const all = everything();
    for (const secret of [BAD_BEARER, SECRET_QUERY, "COOKIE_VALUE", "?key=", "Bearer"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("a wrong ?key= alone is not logged", async () => {
    await run({ query: SECRET_QUERY });

    expect(at("warn")).toHaveLength(1);
    expect(everything()).not.toContain(SECRET_QUERY);
  });

  it("a tunneled request logs the socket address, not Cf-Connecting-Ip", async () => {
    await run({
      host: "tb.example.com",
      headers: { "cf-connecting-ip": TUNNEL_IP },
    });

    expect(at("warn")[0].fields.remoteAddr).toBe("127.0.0.1");
    expect(everything()).not.toContain(TUNNEL_IP);
    expect(everything()).not.toContain("tb.example.com");
  });

  it("a plaintext credential over the relay is logged as a rejection", async () => {
    const r = await run({ relay: true, headers: { authorization: `Bearer ${API_KEY}` } });

    expect(r.status).toBe(401);
    expect(at("warn")).toHaveLength(1);
    expect(at("warn")[0].fields.event).toBe("auth.rejected");
    expect(everything()).not.toContain(API_KEY);
  });

  it("two WebSocket tickets are logged as a rejection", async () => {
    const r = await run({
      path: "/ws",
      headers: {
        upgrade: "websocket",
        "x-tb-ticket": "TICKET_ONE_not_real",
        "sec-websocket-protocol": "threadbase-e2ee-v1, tb-ticket.TICKET_TWO_not_real",
      },
    });

    expect(r.status).toBe(401);
    expect(at("warn")).toHaveLength(1);
    expect(at("warn")[0].fields.event).toBe("auth.rejected");
    expect(everything()).not.toContain("TICKET_");
  });

  it("an unresolved WebSocket ticket is logged as a rejection", async () => {
    const r = await run({
      path: "/ws",
      headers: { upgrade: "websocket", "x-tb-ticket": "TICKET_VALUE_not_real" },
    });

    expect(r.status).toBe(401);
    expect(at("warn")).toHaveLength(1);
    expect(at("warn")[0].fields.event).toBe("auth.rejected");
    expect(at("warn")[0].fields.path).toBe("/ws");
    expect(everything()).not.toContain("TICKET_VALUE_not_real");
  });
});

describe("accepting branches log at debug, structured only", () => {
  const expectOneDebug = (event: string) => {
    expect(at("warn")).toHaveLength(0);
    expect(at("debug")).toHaveLength(1);
    expect(at("debug")[0].fields).toEqual({
      event,
      path: "/api/devices",
      method: "GET",
      remoteAddr: "127.0.0.1",
    });
    // "pino": the default dest also console.logs the message at a terminal,
    // with no level filter, on every request.
    expect(at("debug")[0].dest).toBe("pino");
  };

  it("the --local-no-auth bypass", async () => {
    const r = await run({ localNoAuth: true });

    expect(r.nexts).toBe(1);
    expectOneDebug("auth.local_bypass");
  });

  it("a valid bearer", async () => {
    const r = await run({ headers: { authorization: `Bearer ${API_KEY}` } });

    expect(r.nexts).toBe(1);
    expectOneDebug("auth.bearer_ok");
    expect(everything()).not.toContain(API_KEY);
  });

  it("a valid ?key=", async () => {
    const r = await run({ query: API_KEY });

    expect(r.nexts).toBe(1);
    expectOneDebug("auth.key_param_ok");
    expect(everything()).not.toContain(API_KEY);
  });

  it("a valid bearer under --local-no-auth is the bearer branch, not the bypass", async () => {
    await run({ localNoAuth: true, headers: { authorization: `Bearer ${API_KEY}` } });

    expectOneDebug("auth.bearer_ok");
  });
});
