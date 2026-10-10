import type { Context, Next } from "hono";
import { authMiddleware } from "../src/api/middleware/auth.middleware";
import type { Principal } from "../src/services/security/capabilities";

/**
 * `/healthz` is unauthenticated for LOCAL callers only.
 *
 * The menubar poll, the deploy healthcheck and the updater's restart probe hit
 * `http://127.0.0.1:8766/healthz` with no credential and must keep working.
 * Behind the Cloudflare tunnel every request instead arrives from 127.0.0.1 too
 * — the streamer reads no forwarded-IP — so the gate keys on the presence of the
 * `Cf-Connecting-Ip` header cloudflared injects: absent ⇒ local ⇒ open, present
 * ⇒ tunneled ⇒ the normal key/e2ee gate applies.
 *
 * These drive the middleware directly; the whole behaviour is which of `next()`
 * / `c.json(401)` runs.
 */

const API_KEY = "tb_0123456789abcdef0123456789abcdef";

type Harness = {
  run: () => Promise<void>;
  nexts: () => number;
  status: () => number | undefined;
};

function harness(opts: {
  path: string;
  cfConnectingIp?: string;
  authorization?: string;
  localNoAuth?: boolean;
  forwardedFor?: string;
}): Harness {
  let nexts = 0;
  let status: number | undefined;

  const c = {
    req: {
      url: `http://127.0.0.1:8766${opts.path}`,
      method: "GET",
      header: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === "authorization") return opts.authorization;
        if (lower === "cf-connecting-ip") return opts.cfConnectingIp;
        if (lower === "x-forwarded-for") return opts.forwardedFor;
        return undefined;
      },
      query: () => undefined,
    },
    env: { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    json: (_body: unknown, code: number) => {
      status = code;
      return undefined as unknown as Response;
    },
    set: (_key: string, _value: Principal) => {},
    get: () => undefined,
  } as unknown as Context;

  const next: Next = async () => {
    nexts += 1;
  };

  const mw = authMiddleware({
    apiKey: API_KEY,
    localNoAuth: opts.localNoAuth ?? false,
    devicesRepo: () => null,
  } as unknown as Parameters<typeof authMiddleware>[0]);

  return {
    run: () => mw(c, next) as Promise<void>,
    nexts: () => nexts,
    status: () => status,
  };
}

describe("/healthz auth gate", () => {
  it("lets a local poll through with no credential", async () => {
    const h = harness({ path: "/healthz" });
    await h.run();

    expect(h.nexts()).toBe(1);
    expect(h.status()).toBeUndefined();
  });

  it("401s a tunneled probe with no credential", async () => {
    const h = harness({ path: "/healthz", cfConnectingIp: "203.0.113.7" });
    await h.run();

    expect(h.status()).toBe(401);
    expect(h.nexts()).toBe(0);
  });

  it("lets a tunneled request through with the api key", async () => {
    const h = harness({
      path: "/healthz",
      cfConnectingIp: "203.0.113.7",
      authorization: `Bearer ${API_KEY}`,
    });
    await h.run();

    expect(h.nexts()).toBe(1);
    expect(h.status()).toBeUndefined();
  });

  it("401s a tunneled request with the wrong key", async () => {
    const h = harness({
      path: "/healthz",
      cfConnectingIp: "203.0.113.7",
      authorization: "Bearer tb_deadbeefdeadbeefdeadbeefdeadbeef",
    });
    await h.run();

    expect(h.status()).toBe(401);
    expect(h.nexts()).toBe(0);
  });

  // Positive control: a non-healthz path with no credential 401s regardless of
  // the header, so the "local poll" pass above is the /healthz carve-out and not
  // the middleware letting everyone in.
  it("401s a local non-healthz request with no credential", async () => {
    const h = harness({ path: "/api/devices" });
    await h.run();

    expect(h.status()).toBe(401);
    expect(h.nexts()).toBe(0);
  });
});

/**
 * The same loopback-is-not-local problem, for everything else that trusts a
 * loopback caller: the menubar's log viewer paths and `--local-no-auth`. A
 * request through the Cloudflare tunnel arrives from 127.0.0.1 as well, so
 * without the header check it would read the logs, or act as the owner, with no
 * credential at all.
 */
describe("loopback carve-outs behind the tunnel", () => {
  for (const path of ["/api/logs", "/api/logs/meta"]) {
    it(`lets a local caller read ${path} with no credential`, async () => {
      const h = harness({ path });
      await h.run();

      expect(h.nexts()).toBe(1);
      expect(h.status()).toBeUndefined();
    });

    it(`401s a tunneled ${path} with no credential`, async () => {
      const h = harness({ path, cfConnectingIp: "203.0.113.7" });
      await h.run();

      expect(h.status()).toBe(401);
      expect(h.nexts()).toBe(0);
    });
  }

  it("401s /api/logs forwarded by another proxy with no credential", async () => {
    const h = harness({ path: "/api/logs", forwardedFor: "203.0.113.7" });
    await h.run();

    expect(h.status()).toBe(401);
    expect(h.nexts()).toBe(0);
  });

  it("lets a tunneled /api/logs through with the api key", async () => {
    const h = harness({
      path: "/api/logs",
      cfConnectingIp: "203.0.113.7",
      authorization: `Bearer ${API_KEY}`,
    });
    await h.run();

    expect(h.nexts()).toBe(1);
    expect(h.status()).toBeUndefined();
  });

  it("gives a local caller the owner's access under --local-no-auth", async () => {
    const h = harness({ path: "/api/devices", localNoAuth: true });
    await h.run();

    expect(h.nexts()).toBe(1);
    expect(h.status()).toBeUndefined();
  });

  it("401s a tunneled caller with no credential under --local-no-auth", async () => {
    const h = harness({ path: "/api/devices", localNoAuth: true, cfConnectingIp: "203.0.113.7" });
    await h.run();

    expect(h.status()).toBe(401);
    expect(h.nexts()).toBe(0);
  });
});
