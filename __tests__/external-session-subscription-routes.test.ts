import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "fs";
import { Hono } from "hono";
import type { Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/api/app";
import { createMiscRoutes } from "../src/api/routes/misc.routes";
import { PushRepository } from "../src/db/repositories/push.repository";
import { RuntimeStore } from "../src/db/runtime-store";

/** PUT / DELETE /api/push/subscriptions (#1265). */

const TOK_A = "ExponentPushToken[a]";
const TOK_B = "ExponentPushToken[b]";
const CONV = "11111111-2222-3333-4444-555555555555";

let dir: string;
let store: RuntimeStore;
let repo: PushRepository | null;
let server: Server;
let baseUrl: string;
let principal: { kind: "device"; deviceId: string } | { kind: "api-key" };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tb-sub-routes-"));
  store = RuntimeStore.open(join(dir, "runtime.db"));
  repo = new PushRepository(store.getDatabase());
  principal = { kind: "api-key" };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", principal as any);
    await next();
  });
  app.route("/", createMiscRoutes({ pushRepo: () => repo } as never));
  baseUrl = await new Promise<string>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve(`http://127.0.0.1:${info.port}`),
    ) as Server;
  });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const send = (method: string, body: unknown) =>
  fetch(`${baseUrl}/api/push/subscriptions`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PUT /api/push/subscriptions", () => {
  it("stores the subscription and answers 204", async () => {
    repo!.register({ token: TOK_A, platform: "ios" });
    expect((await send("PUT", { token: TOK_A, conversationId: CONV })).status).toBe(204);
    expect([...repo!.subscribedTokens(CONV)]).toEqual([TOK_A]);
  });

  it("answers 404 and stores nothing for a token that is not registered", async () => {
    const res = await send("PUT", { token: TOK_A, conversationId: CONV });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("TOKEN_NOT_FOUND");
    expect(repo!.hasSubscribers(CONV)).toBe(false);
  });

  it("rejects a missing token or a missing or malformed conversationId with 400", async () => {
    repo!.register({ token: TOK_A, platform: "ios" });
    expect((await send("PUT", { conversationId: CONV })).status).toBe(400);
    expect((await send("PUT", { token: TOK_A })).status).toBe(400);
    expect((await send("PUT", { token: TOK_A, conversationId: "../etc/passwd" })).status).toBe(400);
    expect((await send("PUT", { token: TOK_A, conversationId: "a".repeat(129) })).status).toBe(400);
    expect(repo!.hasSubscribers(CONV)).toBe(false);
  });

  it("answers 503 when the push store is unavailable", async () => {
    repo = null;
    const res = await send("PUT", { token: TOK_A, conversationId: CONV });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe("STORE_UNAVAILABLE");
  });

  it("lets a device subscribe its own token, and answers 404 for another device's", async () => {
    repo!.register({ token: TOK_A, platform: "ios", deviceId: "dev-a" });
    repo!.register({ token: TOK_B, platform: "ios", deviceId: "dev-b" });
    principal = { kind: "device", deviceId: "dev-a" };

    expect((await send("PUT", { token: TOK_A, conversationId: CONV })).status).toBe(204);
    expect((await send("PUT", { token: TOK_B, conversationId: CONV })).status).toBe(404);
    expect([...repo!.subscribedTokens(CONV)]).toEqual([TOK_A]);
  });
});

describe("DELETE /api/push/subscriptions", () => {
  it("removes the subscription, and is 204 when there was none", async () => {
    repo!.register({ token: TOK_A, platform: "ios" });
    repo!.subscribe(TOK_A, CONV);

    expect((await send("DELETE", { token: TOK_A, conversationId: CONV })).status).toBe(204);
    expect(repo!.hasSubscribers(CONV)).toBe(false);
    expect((await send("DELETE", { token: TOK_A, conversationId: CONV })).status).toBe(204);
  });

  it("will not remove another device's subscription, but still answers 204", async () => {
    repo!.register({ token: TOK_B, platform: "ios", deviceId: "dev-b" });
    repo!.subscribe(TOK_B, CONV);
    principal = { kind: "device", deviceId: "dev-a" };

    expect((await send("DELETE", { token: TOK_B, conversationId: CONV })).status).toBe(204);
    expect(repo!.hasSubscribers(CONV)).toBe(true);
  });

  it("rejects a missing token with 400", async () => {
    expect((await send("DELETE", { conversationId: CONV })).status).toBe(400);
  });
});
