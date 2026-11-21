import { isAbsolute, relative, sep } from "node:path";
import { Hono } from "hono";
import { BrowsePathNotFoundError, resolveBrowsePath } from "../../browse";
import {
  PinnedDirsFullError,
  type PinnedDirView,
  pinnedDirsFor,
} from "../../db/repositories/pinned-dirs.repository";
import type { AppEnv } from "../app";
import { BodyTooLargeError } from "../handlers/http-helpers";
import type { ApiDeps } from "../types/api-deps";
import { readJsonBody } from "./misc.routes";

const UNAVAILABLE = {
  error: "Pinned directories store is unavailable",
  code: "STORE_UNAVAILABLE",
} as const;

/**
 * Adds `relativePath`, the browse screen's own form ("" for the root, "/"
 * separators), so mobile can tell whether the folder it is showing is pinned.
 * Null when the pin is no longer under the current root.
 */
function withRelative(dirs: PinnedDirView[], root: string | null) {
  return dirs.map((d) => {
    const rel = root === null ? null : relative(root, d.path);
    const inside = rel !== null && !rel.startsWith("..") && !isAbsolute(rel);
    return { ...d, relativePath: inside ? rel.split(sep).join("/") : null };
  });
}

/**
 * Folders pinned on mobile's browse screen, one list per streamer shared by
 * every paired device. Mobile uses it only when `GET /api/info` reports
 * `pinnedDirs: true`.
 */
export const createPinnedDirsRoutes = (
  deps: Pick<ApiDeps, "runtimeStore" | "browseRoot" | "browseUnrestricted">,
) => {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const repo = pinnedDirsFor(deps.runtimeStore());
    if (!repo) return c.json(UNAVAILABLE, 503);
    return c.json({ dirs: withRelative(repo.list(), deps.browseRoot()) });
  });

  // Body `{ path }`: browse-relative (what the browse screen holds) or absolute.
  // Resolved against the browse root, so a pin can never name a folder outside it
  // (unless `unrestrictedBrowse` is on).
  app.put("/", async (c) => {
    const repo = pinnedDirsFor(deps.runtimeStore());
    if (!repo) return c.json(UNAVAILABLE, 503);
    const root = deps.browseRoot();
    if (!root) {
      return c.json(
        {
          error: "File browsing not configured. Set browseRoot on the server.",
          code: "BROWSE_ROOT_NOT_SET",
        },
        403,
      );
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.env.incoming);
    } catch (err) {
      return c.json({ error: "Invalid JSON body" }, err instanceof BodyTooLargeError ? 413 : 400);
    }
    const path = (body as { path?: unknown } | null)?.path;
    if (typeof path !== "string") return c.json({ error: "Missing path field" }, 400);
    let resolved: string;
    try {
      resolved = await resolveBrowsePath(root, path, deps.browseUnrestricted());
    } catch (err) {
      if (err instanceof BrowsePathNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err instanceof Error ? err.message : "Invalid path" }, 400);
    }
    try {
      repo.pin(resolved);
    } catch (err) {
      if (err instanceof PinnedDirsFullError) {
        return c.json({ error: err.message, code: "PINNED_DIRS_FULL" }, 409);
      }
      throw err;
    }
    return c.json({ dirs: withRelative(repo.list(), root) });
  });

  // Idempotent, and 200 with a body: mobile's request helper parses every success as JSON.
  app.delete("/", (c) => {
    const repo = pinnedDirsFor(deps.runtimeStore());
    if (!repo) return c.json(UNAVAILABLE, 503);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path query parameter" }, 400);
    return c.json({ ok: true, removed: repo.unpin(path) });
  });

  return app;
};
