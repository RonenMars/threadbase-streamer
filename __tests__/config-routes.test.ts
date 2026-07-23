import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createConfigRoutes } from "../src/api/routes/config.routes";
import { CLAUDE_FLAGS, type ClaudeFlagValues } from "../src/claude-flags";

function makeApp(
  opts: {
    localNoAuth?: boolean;
    persisted?: boolean;
    values?: ClaudeFlagValues;
    setImpl?: (values: ClaudeFlagValues, extraArgs: string | undefined) => never;
  } = {},
) {
  const setSpy = vi.fn(
    (values: ClaudeFlagValues, extraArgs: string | undefined) =>
      ({ values, extraArgs: extraArgs ?? null, persisted: opts.persisted ?? true }) as const,
  );
  const deps = {
    localNoAuth: opts.localNoAuth ?? false,
    claudeFlagsConfig: () => ({
      registry: CLAUDE_FLAGS,
      values: opts.values ?? {},
      extraArgs: null,
      persisted: opts.persisted ?? true,
    }),
    setClaudeFlagsConfig: opts.setImpl ?? setSpy,
  };
  const app = new Hono();
  app.route("/api/config", createConfigRoutes(deps as never));
  return { app, setSpy };
}

function put(app: Hono, body: unknown) {
  return app.request("/api/config/claude-flags", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/config/claude-flags", () => {
  // The registry ships with the values so a client renders the form from one
  // round-trip and can never offer a flag this server doesn't know about.
  it("returns the registry alongside the current values", async () => {
    const { app } = makeApp({ values: { maxBudgetUsd: "5" } });
    const res = await app.request("/api/config/claude-flags");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.values).toEqual({ maxBudgetUsd: "5" });
    expect(body.registry.map((f: { id: string }) => f.id)).toContain("permissionMode");
    expect(body.persisted).toBe(true);
  });
});

describe("PUT /api/config/claude-flags", () => {
  it("applies valid values", async () => {
    const { app, setSpy } = makeApp();
    const res = await put(app, { values: { permissionMode: "bypassPermissions" } });

    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith({ permissionMode: "bypassPermissions" }, undefined);
    expect((await res.json()).values).toEqual({ permissionMode: "bypassPermissions" });
  });

  // Same guard as POST /api/auth/rotate: under localNoAuth any local process can
  // call this unauthenticated, and this endpoint can disable Claude's permission
  // prompts for every future session on the machine.
  it("refuses under localNoAuth", async () => {
    const { app, setSpy } = makeApp({ localNoAuth: true });
    const res = await put(app, { values: {} });

    expect(res.status).toBe(403);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const { app } = makeApp();
    expect((await put(app, { values: "not-an-object" })).status).toBe(400);
    expect((await put(app, { unknownKey: 1, values: {} })).status).toBe(400);
  });

  it("rejects extraArgs containing a newline", async () => {
    const { app, setSpy } = makeApp();
    const res = await put(app, { values: {}, extraArgs: "--bare\n--evil" });

    expect(res.status).toBe(400);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid json", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/config/claude-flags", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });

  // Mirrors the rotate contract: the change still applies in memory, but the
  // caller is told it won't survive a restart because a CLI flag will win.
  it("warns when the values cannot be persisted", async () => {
    const { app } = makeApp({ persisted: false });
    const body = await (await put(app, { values: {} })).json();

    expect(body.persisted).toBe(false);
    expect(body.warning).toMatch(/--claude-flag/);
  });

  it("surfaces a setter failure as a 400", async () => {
    const { app } = makeApp({
      setImpl: () => {
        throw new Error("claude_extra_args must not contain newlines");
      },
    });
    const res = await put(app, { values: {} });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/newlines/);
  });
});
