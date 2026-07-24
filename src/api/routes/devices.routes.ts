import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

/**
 * Paired-device management (C5 / mobile U10).
 *
 * Revoking a device previously meant rotating the shared API key, which
 * de-authenticated every other device at the same time. These routes make
 * revocation per-device and give the client something to display: which devices
 * exist, what each may do, and when it was last seen.
 *
 * No response ever includes a device token or its hash. A management surface
 * has no reason to hand back a credential, and this endpoint is exactly where
 * an accidental echo would be most damaging.
 */
export const createDeviceRoutes = (deps: Pick<ApiDeps, "devicesRepo">) => {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const repo = deps.devicesRepo();
    // Report honestly rather than pretending no devices are paired: an empty
    // list and "the registry is unavailable" mean very different things to a
    // user deciding whether to revoke something.
    if (!repo) return c.json({ devices: [], available: false });
    return c.json({ devices: repo.list(), available: true });
  });

  app.post("/:id/revoke", (c) => {
    const repo = deps.devicesRepo();
    if (!repo) {
      return c.json({ error: "Device registry is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }

    const id = c.req.param("id");
    const existing = repo.get(id);
    if (!existing) return c.json({ error: "Device not found" }, 404);

    // Idempotent: revoking an already-revoked device is not an error, so a
    // client retrying after a dropped response does not see a spurious failure.
    if (existing.revoked_at != null) {
      return c.json({ ok: true, alreadyRevoked: true });
    }

    repo.revoke(id);
    return c.json({ ok: true, alreadyRevoked: false });
  });

  return app;
};
