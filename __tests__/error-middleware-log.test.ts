import { Hono } from "hono";
import { beforeEach, vi } from "vitest";

/**
 * #489 — Hono's global error handler answered 500 and logged nothing, so a
 * crashing handler left no trace beyond the `[req] … → 500` line.
 *
 * Its own file because the logger mock is module-scoped.
 */

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

const { errorMiddleware } = await import("../src/api/middleware/error.middleware");

const appThrowing = (err: unknown) => {
  const app = new Hono();
  app.onError(errorMiddleware as never);
  app.all("/api/boom", () => {
    throw err;
  });
  return app;
};
const unhandled = () => h.calls.filter((c) => c.fields?.event === "http.unhandled_error");

describe("global error handler logging", () => {
  beforeEach(() => {
    h.calls.length = 0;
  });

  it("logs an unhandled error at error level before answering 500", async () => {
    const err = new Error("kaboom");
    const res = await appThrowing(err).request("/api/boom", { method: "POST" });

    expect(res.status).toBe(500);
    expect(unhandled()).toHaveLength(1);
    const [call] = unhandled();
    expect(call.level).toBe("error");
    expect(call.msg).toBe("[http] unhandled error");
    expect(call.fields).toMatchObject({
      path: "/api/boom",
      method: "POST",
      err: { message: "kaboom", stack: err.stack },
    });
  });

  it("never logs the query string, headers or request body", async () => {
    await appThrowing(new Error("kaboom")).request("/api/boom?key=tb_secret_key&x=1", {
      method: "POST",
      headers: { authorization: "Bearer tb_secret_bearer" },
      body: JSON.stringify({ password: "hunter2" }),
    });

    const logged = JSON.stringify(h.calls);
    expect(logged).not.toContain("tb_secret_key");
    expect(logged).not.toContain("tb_secret_bearer");
    expect(logged).not.toContain("hunter2");
    expect(unhandled()[0].fields.path).toBe("/api/boom");
  });

  it("does not log an error that carries its own HTTP status", async () => {
    const err = Object.assign(new Error("nope"), {
      statusCode: 503,
      code: "PROVIDER_NOT_INSTALLED",
    });
    const res = await appThrowing(err).request("/api/boom");

    expect(res.status).toBe(503);
    expect(h.calls).toEqual([]);
  });
});
