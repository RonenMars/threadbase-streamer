import type { Context, Next } from "hono";
import { authMiddleware } from "../src/api/middleware/auth.middleware";
import type { Principal } from "../src/services/security/capabilities";

/**
 * `--local-no-auth` and the capability layer (TB-S-23).
 *
 * The flag used to return `next()` for any loopback caller before the
 * capability check ran and before `c.set("principal")` — so the request reached
 * its handler with no principal at all. Access was unchanged by that (the
 * bypass granted everything), but nothing downstream could tell an authorized
 * caller from an unexamined one, and the WebSocket guard took its
 * null-principal path instead of an authorization decision.
 *
 * These drive the middleware directly. There is no server to stand up: the
 * whole behaviour is which of `next()` / `c.json(401)` runs, and what lands in
 * `c.set("principal")`.
 */

type Harness = {
  run: () => Promise<void>;
  nexts: () => number;
  principal: () => Principal | undefined;
  status: () => number | undefined;
};

function harness(opts: {
  localNoAuth: boolean;
  remoteAddress?: string;
  path?: string;
  authorization?: string;
}): Harness {
  let nexts = 0;
  let principal: Principal | undefined;
  let status: number | undefined;

  const c = {
    req: {
      url: `http://127.0.0.1:8766${opts.path ?? "/api/devices"}`,
      method: "GET",
      header: (name: string) =>
        name.toLowerCase() === "authorization" ? opts.authorization : undefined,
      query: () => undefined,
    },
    env: { incoming: { socket: { remoteAddress: opts.remoteAddress } } },
    json: (_body: unknown, code: number) => {
      status = code;
      return undefined as unknown as Response;
    },
    set: (_key: string, value: Principal) => {
      principal = value;
    },
  } as unknown as Context;

  const next: Next = async () => {
    nexts += 1;
  };

  const mw = authMiddleware({
    apiKey: "tb_0123456789abcdef0123456789abcdef",
    localNoAuth: opts.localNoAuth,
    devicesRepo: () => null,
  } as unknown as Parameters<typeof authMiddleware>[0]);

  return {
    run: () => mw(c, next) as Promise<void>,
    nexts: () => nexts,
    principal: () => principal,
    status: () => status,
  };
}

describe("--local-no-auth resolves a principal instead of bypassing", () => {
  it("gives a loopback caller with no credential the owner principal", async () => {
    const h = harness({ localNoAuth: true, remoteAddress: "127.0.0.1" });
    await h.run();

    expect(h.nexts()).toBe(1);
    expect(h.status()).toBeUndefined();
    // Same authority the bypass granted: the owner's, admin included. Narrowing
    // it here would break local tooling that reaches admin routes today.
    expect(h.principal()?.capabilities).toContain("admin");
    expect(h.principal()?.capabilities).toContain("session:control");
  });

  it("does the same over IPv6 loopback", async () => {
    const h = harness({ localNoAuth: true, remoteAddress: "::1" });
    await h.run();

    expect(h.nexts()).toBe(1);
    expect(h.principal()?.capabilities).toContain("admin");
  });

  it("ignores a wrong credential from loopback rather than demoting the caller", async () => {
    const h = harness({
      localNoAuth: true,
      remoteAddress: "127.0.0.1",
      authorization: "Bearer tb_deadbeefdeadbeefdeadbeefdeadbeef",
    });
    await h.run();

    expect(h.nexts()).toBe(1);
    expect(h.principal()?.capabilities).toContain("admin");
  });

  // Positive controls: both of these 401 today and must keep doing so, or the
  // assertions above would pass against a middleware that lets everyone in.
  it("401s a loopback caller with no credential when the flag is off", async () => {
    const h = harness({ localNoAuth: false, remoteAddress: "127.0.0.1" });
    await h.run();

    expect(h.status()).toBe(401);
    expect(h.nexts()).toBe(0);
    expect(h.principal()).toBeUndefined();
  });

  it("401s a remote caller with no credential even when the flag is on", async () => {
    const h = harness({ localNoAuth: true, remoteAddress: "192.168.1.40" });
    await h.run();

    expect(h.status()).toBe(401);
    expect(h.nexts()).toBe(0);
    expect(h.principal()).toBeUndefined();
  });
});
