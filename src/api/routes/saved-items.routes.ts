import type Database from "better-sqlite3";
import { Hono } from "hono";
import {
  SavedItemsFullError,
  SavedItemsRepository,
} from "../../db/repositories/saved-items.repository";
import {
  SavedItemInputSchema,
  SavedItemsOrderSchema,
  savedItemKey,
} from "../../schemas/saved-items.schema";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";
import { BodyTooLargeError, readJsonBody } from "./misc.routes";

/**
 * Saved (favorite) sessions and conversations, shared by every device paired
 * with this streamer. Mobile keeps its own copy as the one the UI reads and
 * syncs against this list only when `GET /api/info` reports `savedItems: true`.
 */

const repos = new WeakMap<Database.Database, SavedItemsRepository>();

function repoFor(deps: Pick<ApiDeps, "runtimeStore">): SavedItemsRepository | null {
  const db = deps.runtimeStore()?.getDatabase();
  if (!db) return null;
  let repo = repos.get(db);
  if (!repo) {
    repo = new SavedItemsRepository(db);
    repos.set(db, repo);
  }
  return repo;
}

const UNAVAILABLE = {
  error: "Saved items store is unavailable",
  code: "STORE_UNAVAILABLE",
} as const;

export const createSavedItemsRoutes = (deps: Pick<ApiDeps, "runtimeStore" | "wsHub">) => {
  const app = new Hono<AppEnv>();

  const announce = (revision: number): void => {
    deps.wsHub.broadcast({ type: "saved_items_changed", revision });
  };

  const readBody = async (c: { env: AppEnv["Bindings"] }) => {
    try {
      return { ok: true as const, body: await readJsonBody(c.env.incoming) };
    } catch (err) {
      return { ok: false as const, tooLarge: err instanceof BodyTooLargeError };
    }
  };

  app.get("/", (c) => {
    const repo = repoFor(deps);
    if (!repo) return c.json(UNAVAILABLE, 503);
    return c.json(repo.list());
  });

  // Before `/:key` for readability; a key always contains `::`, so it can never be "order".
  app.put("/order", async (c) => {
    const repo = repoFor(deps);
    if (!repo) return c.json(UNAVAILABLE, 503);
    const read = await readBody(c);
    if (!read.ok) return c.json({ error: "Invalid JSON body" }, read.tooLarge ? 413 : 400);
    const parsed = SavedItemsOrderSchema.safeParse(read.body);
    if (!parsed.success) {
      return c.json({ error: `Invalid order: ${parsed.error.issues[0]?.message}` }, 400);
    }
    const list = repo.reorder(parsed.data.keys);
    announce(list.revision);
    return c.json(list);
  });

  app.put("/:key", async (c) => {
    const repo = repoFor(deps);
    if (!repo) return c.json(UNAVAILABLE, 503);
    const read = await readBody(c);
    if (!read.ok) return c.json({ error: "Invalid JSON body" }, read.tooLarge ? 413 : 400);
    const parsed = SavedItemInputSchema.safeParse(read.body);
    if (!parsed.success) {
      return c.json({ error: `Invalid saved item: ${parsed.error.issues[0]?.message}` }, 400);
    }
    const key = c.req.param("key");
    if (savedItemKey(parsed.data) !== key) {
      return c.json({ error: "Key does not match the item", code: "KEY_MISMATCH" }, 400);
    }
    try {
      const item = repo.upsert(parsed.data, c.get("principal")?.deviceId);
      announce(repo.revision());
      return c.json(item);
    } catch (err) {
      if (err instanceof SavedItemsFullError) {
        return c.json({ error: err.message, code: "SAVED_ITEMS_FULL" }, 409);
      }
      throw err;
    }
  });

  // Idempotent: a retry after a lost response must not look like a failure.
  app.delete("/:key", (c) => {
    const repo = repoFor(deps);
    if (!repo) return c.json(UNAVAILABLE, 503);
    if (repo.remove(c.req.param("key"))) announce(repo.revision());
    return c.body(null, 204);
  });

  return app;
};
