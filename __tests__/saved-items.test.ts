import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "fs";
import { Hono } from "hono";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { createSavedItemsRoutes } from "../src/api/routes/saved-items.routes";
import { SavedItemsRepository } from "../src/db/repositories/saved-items.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { SAVED_ITEMS_MAX } from "../src/schemas/saved-items.schema";
import { requiredCapability } from "../src/services/security/capabilities";
import type { WSMessage } from "../src/types";

let dir: string;
let store: RuntimeStore;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let broadcasts: WSMessage[];

const session = (id: string, label = `Session ${id}`) => ({
  kind: "session",
  label,
  sessionId: id,
});

const put = (key: string, body: object | string) =>
  fetch(`${baseUrl}/api/saved-items/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const list = async () =>
  (await (await fetch(`${baseUrl}/api/saved-items`)).json()) as {
    items: { key: string; label: string; kind: string }[];
    revision: number;
  };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tb-saved-items-"));
  store = RuntimeStore.open(join(dir, "runtime.db"));
  broadcasts = [];
  const app = new Hono();
  app.route(
    "/api/saved-items",
    createSavedItemsRoutes({
      runtimeStore: () => store,
      wsHub: { broadcast: (m: WSMessage) => broadcasts.push(m) },
    } as never),
  );
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(() => r(null)));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("saved items API", () => {
  it("starts empty", async () => {
    expect(await list()).toEqual({ items: [], revision: 0 });
  });

  it("saves items in order and announces each write", async () => {
    expect((await put("session::a", session("a"))).status).toBe(200);
    const conv = { kind: "conversation", label: "Conv", conversationId: "c1", projectId: "p1" };
    expect((await put("conversation::c1", conv)).status).toBe(200);
    const chat = {
      kind: "project-chat",
      label: "Chat",
      chatType: "session",
      chatId: "x",
      projectId: "p1",
    };
    expect((await put("project-chat::session::x", chat)).status).toBe(200);

    const { items, revision } = await list();
    expect(items.map((i) => i.key)).toEqual([
      "session::a",
      "conversation::c1",
      "project-chat::session::x",
    ]);
    expect(items[1]).toMatchObject({ kind: "conversation", conversationId: "c1", projectId: "p1" });
    expect(revision).toBe(3);
    expect(broadcasts).toEqual(
      [1, 2, 3].map((r) => ({ type: "saved_items_changed", revision: r })),
    );
  });

  it("re-saving a key updates it in place", async () => {
    await put("session::a", session("a"));
    await put("session::b", session("b"));
    await put("session::a", session("a", "Renamed"));

    const { items } = await list();
    expect(items.map((i) => [i.key, i.label])).toEqual([
      ["session::a", "Renamed"],
      ["session::b", "Session b"],
    ]);
  });

  it("reorders, ignoring unknown keys and keeping unlisted ones", async () => {
    for (const id of ["a", "b", "c"]) await put(`session::${id}`, session(id));

    const res = await fetch(`${baseUrl}/api/saved-items/order`, {
      method: "PUT",
      body: JSON.stringify({ keys: ["session::c", "session::ghost", "session::a"] }),
    });

    expect(res.status).toBe(200);
    expect((await list()).items.map((i) => i.key)).toEqual([
      "session::c",
      "session::a",
      "session::b",
    ]);
    expect(broadcasts.at(-1)).toEqual({ type: "saved_items_changed", revision: 4 });
  });

  it("deletes idempotently and announces only a real removal", async () => {
    await put("session::a", session("a"));

    const first = await fetch(`${baseUrl}/api/saved-items/session%3A%3Aa`, { method: "DELETE" });
    const second = await fetch(`${baseUrl}/api/saved-items/session%3A%3Aa`, { method: "DELETE" });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([(await first.json()).removed, (await second.json()).removed]).toEqual([true, false]);
    expect((await list()).items).toEqual([]);
    expect(broadcasts).toHaveLength(2);
  });

  it.each([
    ["an unknown kind", "dir::x", { kind: "dir", label: "x", id: "x" }],
    ["a missing id", "session::a", { kind: "session", label: "x" }],
    ["an empty label", "session::a", { kind: "session", label: " ", sessionId: "a" }],
    [
      "a project chat without a project",
      "project-chat::session::x",
      { kind: "project-chat", label: "x", chatType: "session", chatId: "x" },
    ],
    ["a key that does not match the item", "session::other", session("a")],
    ["malformed JSON", "session::a", "{"],
  ])("rejects %s", async (_name, key, body) => {
    expect((await put(key, body)).status).toBe(400);
    expect((await list()).items).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it("rejects an invalid order body", async () => {
    const res = await fetch(`${baseUrl}/api/saved-items/order`, {
      method: "PUT",
      body: JSON.stringify({ keys: "session::a" }),
    });
    expect(res.status).toBe(400);
  });

  it(`refuses item ${SAVED_ITEMS_MAX + 1} but still updates an existing one`, async () => {
    const repo = new SavedItemsRepository(store.getDatabase());
    for (let i = 0; i < SAVED_ITEMS_MAX; i++)
      repo.upsert({ kind: "session", label: "s", sessionId: `s${i}` });

    const refused = await put("session::new", session("new"));
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("SAVED_ITEMS_FULL");
    expect((await put("session::s0", session("s0", "Still fine"))).status).toBe(200);
  });

  it("answers 503 when runtime.db is unavailable", async () => {
    const app = new Hono();
    app.route(
      "/",
      createSavedItemsRoutes({ runtimeStore: () => null, wsHub: { broadcast: () => {} } } as never),
    );
    expect((await app.request("/")).status).toBe(503);
  });
});

describe("saved items storage", () => {
  it("lives in runtime.db and survives a reopen", async () => {
    await put("session::a", session("a"));
    store.close();
    store = RuntimeStore.open(join(dir, "runtime.db"));

    expect(new SavedItemsRepository(store.getDatabase()).list().items.map((i) => i.key)).toEqual([
      "session::a",
    ]);
  });
});

describe("saved items capabilities", () => {
  it("lets a read-only device read but not write", () => {
    expect(requiredCapability("/api/saved-items", "GET")).toBe("history:read");
    for (const method of ["PUT", "DELETE"]) {
      expect(requiredCapability("/api/saved-items/session::a", method)).toBe("session:control");
    }
    expect(requiredCapability("/api/saved-items/order", "PUT")).toBe("session:control");
  });
});
