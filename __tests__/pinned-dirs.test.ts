import { serve } from "@hono/node-server";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { Hono } from "hono";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { createPinnedDirsRoutes } from "../src/api/routes/pinned-dirs.routes";
import {
  PINNED_DIRS_MAX,
  PinnedDirsFullError,
  PinnedDirsRepository,
} from "../src/db/repositories/pinned-dirs.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { requiredCapability } from "../src/services/security/capabilities";

let dir: string;
let root: string;
let store: RuntimeStore;
let repo: PinnedDirsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-pinned-dirs-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "tb-pinned-root-")));
  mkdirSync(join(root, "proj", "sub"), { recursive: true });
  store = RuntimeStore.open(join(dir, "runtime.db"));
  repo = new PinnedDirsRepository(store.getDatabase());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("PinnedDirsRepository", () => {
  it("lists in pin order, canonicalizes, and re-pinning keeps the position", () => {
    repo.pin("/b", 2000);
    repo.pin("/a/", 3000);
    repo.pin("/b", 4000);
    expect(repo.list()).toEqual([
      { path: "/b", pinnedAt: new Date(2000).toISOString() },
      { path: "/a", pinnedAt: new Date(3000).toISOString() },
    ]);
  });

  it("unpins idempotently", () => {
    repo.pin("/a");
    expect(repo.unpin("/a/")).toBe(true);
    expect(repo.unpin("/a")).toBe(false);
    expect(repo.list()).toEqual([]);
  });

  it(`refuses pin ${PINNED_DIRS_MAX + 1} but still accepts a re-pin`, () => {
    for (let i = 0; i < PINNED_DIRS_MAX; i++) repo.pin(`/d${i}`, i);
    expect(() => repo.pin("/one-more")).toThrow(PinnedDirsFullError);
    expect(() => repo.pin("/d0")).not.toThrow();
    expect(repo.list()).toHaveLength(PINNED_DIRS_MAX);
  });

  it("survives reopening runtime.db", () => {
    repo.pin("/kept");
    store.close();
    store = RuntimeStore.open(join(dir, "runtime.db"));
    expect(new PinnedDirsRepository(store.getDatabase()).list().map((d) => d.path)).toEqual([
      "/kept",
    ]);
  });
});

describe("/api/pinned-dirs", () => {
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let browseRoot: string | null;
  let runtime: RuntimeStore | null;

  const put = (body: unknown) =>
    fetch(`${baseUrl}/api/pinned-dirs`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const list = async () =>
    (await (await fetch(`${baseUrl}/api/pinned-dirs`)).json()) as { dirs: { path: string }[] };

  beforeEach(async () => {
    browseRoot = root;
    runtime = store;
    const app = new Hono();
    app.route(
      "/api/pinned-dirs",
      createPinnedDirsRoutes({
        runtimeStore: () => runtime,
        browseRoot: () => browseRoot,
      } as never),
    );
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(() => r(null)));
  });

  it("pins a browse-relative path as its absolute path and lists it", async () => {
    const res = await put({ path: "proj/sub" });
    expect(res.status).toBe(200);
    expect((await res.json()).dirs.map((d: { path: string }) => d.path)).toEqual([
      join(root, "proj", "sub"),
    ]);
    expect((await list()).dirs.map((d) => d.path)).toEqual([join(root, "proj", "sub")]);
  });

  it("pins the root for an empty path and accepts an absolute path under it", async () => {
    await put({ path: "" });
    await put({ path: join(root, "proj") });
    expect((await list()).dirs.map((d) => d.path)).toEqual([root, join(root, "proj")]);
  });

  it("reports each pin's browse-relative path, null once outside the root", async () => {
    await put({ path: "" });
    await put({ path: "proj/sub" });
    repo.pin("/elsewhere", Date.now() + 60_000);
    const dirs = (await list()).dirs as { relativePath: string | null }[];
    expect(dirs.map((d) => d.relativePath)).toEqual(["", "proj/sub", null]);
  });

  it.each([
    ["a path outside the browse root", { path: "../../etc" }, 400],
    ["a missing folder", { path: "proj/gone" }, 404],
    ["a missing path field", {}, 400],
    ["malformed JSON", "{", 400],
  ])("rejects %s", async (_name, body, status) => {
    expect((await put(body)).status).toBe(status);
    expect((await list()).dirs).toEqual([]);
  });

  it("answers 409 when full", async () => {
    for (let i = 0; i < PINNED_DIRS_MAX; i++) repo.pin(`/d${i}`, i);
    const res = await put({ path: "proj" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PINNED_DIRS_FULL");
  });

  it("answers 403 before the browse root is configured", async () => {
    browseRoot = null;
    expect((await put({ path: "proj" })).status).toBe(403);
  });

  it("unpins idempotently with a 200 body", async () => {
    await put({ path: "proj" });
    const url = `${baseUrl}/api/pinned-dirs?path=${encodeURIComponent(join(root, "proj"))}`;
    const first = await fetch(url, { method: "DELETE" });
    const second = await fetch(url, { method: "DELETE" });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([(await first.json()).removed, (await second.json()).removed]).toEqual([true, false]);
    expect((await fetch(`${baseUrl}/api/pinned-dirs`, { method: "DELETE" })).status).toBe(400);
  });

  it("answers 503 without a runtime store", async () => {
    runtime = null;
    expect((await fetch(`${baseUrl}/api/pinned-dirs`)).status).toBe(503);
    expect((await put({ path: "proj" })).status).toBe(503);
  });
});

it("gates every method on fs:browse", () => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    expect(requiredCapability("/api/pinned-dirs", method)).toBe("fs:browse");
  }
});
