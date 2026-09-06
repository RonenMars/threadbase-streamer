import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "fs";
import { Hono } from "hono";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHonoApp } from "../src/api/app";
import { createDeviceRoutes } from "../src/api/routes/devices.routes";
import type { ApiDeps } from "../src/api/types/api-deps";
import { ConversationCache } from "../src/conversation-cache";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { PushRepository } from "../src/db/repositories/push.repository";
import { RuntimeStore } from "../src/db/runtime-store";

/**
 * Revoking or erasing a device deletes its push tokens.
 *
 * The two tables are in different databases — `devices` in runtime.db,
 * `push_tokens` in cache.db — so there is no foreign key doing this and the
 * cascade only exists as two repository calls in the route. Without it a
 * revoked phone kept a live delivery credential on the server, which is exactly
 * what revoking is supposed to take away.
 *
 * The second half of the file covers what makes the cascade reach anything at
 * all: registration attributes a token to the AUTHENTICATED device rather than
 * to a body field. tb-mobile sent its own install UUID there, which matches no
 * row in `devices`, so every token was attributed to a device that does not
 * exist and this cascade would have deleted nothing.
 */

let dir: string;
let store: RuntimeStore;
let cache: ConversationCache;
let devices: DevicesRepository;
let push: PushRepository;

const makeApp = (pushRepo: () => PushRepository | null = () => push) => {
  const app = new Hono();
  app.route(
    "/api/devices",
    createDeviceRoutes({
      devicesRepo: () => devices,
      pushRepo,
      // The e2ee side of revocation has its own tests; this one only needs the
      // hub not to throw.
      wsHub: { closeDevice: () => 0 },
    } as never),
  );
  return app;
};

const tokensFor = (deviceId: string) => push.listHealth().filter((t) => t.deviceId === deviceId);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-push-cascade-"));
  store = RuntimeStore.open(join(dir, "runtime.db"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  devices = new DevicesRepository(store.getDatabase());
  push = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  store.close();
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Two paired devices, each holding one token. */
const pairTwo = () => {
  const a = devices.register({ publicKey: "pk-a", name: "Phone A" }).deviceId;
  const b = devices.register({ publicKey: "pk-b", name: "Phone B" }).deviceId;
  push.register({ token: "tok-a", platform: "ios", deviceId: a });
  push.register({ token: "tok-b", platform: "ios", deviceId: b });
  return { a, b };
};

describe("POST /api/devices/:id/revoke", () => {
  it("deletes the revoked device's tokens and leaves the other device's", async () => {
    const { a, b } = pairTwo();

    const res = await makeApp().request(`/api/devices/${a}/revoke`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(tokensFor(a)).toHaveLength(0);
    expect(tokensFor(b)).toHaveLength(1);
  });

  // Revoke is idempotent, and the second call has to finish the job in case the
  // first one was answered before this cascade existed.
  it("still deletes tokens on an already-revoked device", async () => {
    const { a } = pairTwo();
    devices.revoke(a);

    const res = await makeApp().request(`/api/devices/${a}/revoke`, { method: "POST" });

    expect((await res.json()).alreadyRevoked).toBe(true);
    expect(tokensFor(a)).toHaveLength(0);
  });

  // The cache and the runtime store fail independently. A device revoke must
  // never fail because the conversation cache did not open.
  it("succeeds when the push store is unavailable", async () => {
    const { a } = pairTwo();

    const res = await makeApp(() => null).request(`/api/devices/${a}/revoke`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyRevoked: false });
  });
});

describe("DELETE /api/devices/:id", () => {
  it("deletes the erased device's tokens", async () => {
    const { a, b } = pairTwo();

    const res = await makeApp().request(`/api/devices/${a}?force=1`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(tokensFor(a)).toHaveLength(0);
    expect(tokensFor(b)).toHaveLength(1);
  });

  // Refused, so nothing was erased — and nothing may be taken away either.
  it("keeps the tokens when the delete is refused as active", async () => {
    const { a } = pairTwo();

    const res = await makeApp().request(`/api/devices/${a}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(tokensFor(a)).toHaveLength(1);
  });
});

describe("DELETE /api/devices", () => {
  // The ids have to be collected before the bulk delete: afterwards there is no
  // row left to name, and the tokens would outlive the device silently.
  it("deletes the tokens of every device it erases", async () => {
    const { a, b } = pairTwo();
    devices.revoke(a);

    const res = await makeApp().request("/api/devices", { method: "DELETE" });

    expect((await res.json()).deleted).toBe(1);
    expect(tokensFor(a)).toHaveLength(0);
    expect(tokensFor(b)).toHaveLength(1);
  });
});

describe("attributing a token to the authenticated device", () => {
  let server: ReturnType<typeof serve>;
  let baseUrl: string;

  const API_KEY = "tb_0123456789abcdef0123456789abcdef";

  beforeEach(async () => {
    const deps = {
      apiKey: API_KEY,
      localNoAuth: false,
      logMenubarRequests: false,
      browserCors: undefined,
      publicUrl: null,
      devicesRepo: () => devices,
      pushRepo: () => push,
      liveActivityPushEnabled: () => false,
      sessionStore: { list: () => [] },
      ptyAttachedIds: () => new Set<string>(),
      rotateApiKey: () => ({ newKey: "x", persisted: false }),
      featureFlagsConfig: () => ({ registry: [], values: {}, sources: {} }),
    } as unknown as ApiDeps;

    // A real node-server rather than app.request(): the push routes read the
    // raw Node request off `c.env.incoming`, which only exists behind one.
    server = serve({ fetch: createHonoApp(deps).fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(() => r(null)));
  });

  const register = (bearer: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/push/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "ios", ...body }),
    });

  const unregister = (bearer: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/push/register`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // The bug this fixes verbatim: the body's id was trusted, so the row named a
  // device the registry has never heard of.
  it("ignores a client-supplied device id when a device is authenticated", async () => {
    const { deviceId, deviceToken } = devices.register({ publicKey: "pk-a" });

    await register(deviceToken, { token: "tok-a", deviceId: "some-install-uuid" });

    expect(push.get("tok-a")?.device_id).toBe(deviceId);
  });

  // Rows written by the old handler heal on the next registration rather than
  // needing a migration — the upsert takes the new id whenever it is non-null.
  it("heals a row that was stored under the client's own id", async () => {
    const { deviceId, deviceToken } = devices.register({ publicKey: "pk-a" });
    push.register({ token: "tok-a", platform: "ios", deviceId: "some-install-uuid" });

    await register(deviceToken, { token: "tok-a" });

    expect(push.get("tok-a")?.device_id).toBe(deviceId);
  });

  // The shared api key names no device of its own, so the body is all there is.
  it("still honours the body for the shared api key", async () => {
    await register(API_KEY, { token: "tok-k", deviceId: "dev-from-body" });

    expect(push.get("tok-k")?.device_id).toBe("dev-from-body");
  });

  it("lets a device retire its own token", async () => {
    const { deviceToken } = devices.register({ publicKey: "pk-a" });
    await register(deviceToken, { token: "tok-a" });

    const res = await unregister(deviceToken, { token: "tok-a" });

    expect(res.status).toBe(204);
    expect(push.get("tok-a")).toBeNull();
  });

  // The route is given only a token value, so without the ownership term any
  // device holding `notifications` could retire a sibling's push token.
  it("refuses to retire another device's token", async () => {
    const a = devices.register({ publicKey: "pk-a" });
    const b = devices.register({ publicKey: "pk-b" });
    await register(b.deviceToken, { token: "tok-b" });

    // Still 204: unregister is idempotent, and telling the caller whether a
    // token it does not own exists would be an oracle.
    const res = await unregister(a.deviceToken, { token: "tok-b" });

    expect(res.status).toBe(204);
    expect(push.get("tok-b")?.device_id).toBe(b.deviceId);
  });
});
