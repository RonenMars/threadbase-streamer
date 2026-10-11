import { Hono } from "hono";
import { RECENT_DIRS_MAX, recentDirsFor } from "../../db/repositories/recent-dirs.repository";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

/**
 * Directories sessions were started in, newest first. Recorded at spawn into
 * runtime.db, so the list survives restarts — unlike the session list mobile
 * used to derive it from.
 */
export const createRecentDirsRoutes = (deps: Pick<ApiDeps, "runtimeStore">) => {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const repo = recentDirsFor(deps.runtimeStore());
    if (!repo) {
      return c.json(
        { error: "Recent directories store is unavailable", code: "STORE_UNAVAILABLE" },
        503,
      );
    }
    const raw = Number(c.req.query("limit"));
    const limit = Number.isInteger(raw) && raw > 0 ? raw : RECENT_DIRS_MAX;
    return c.json({ dirs: repo.list(limit) });
  });

  return app;
};
