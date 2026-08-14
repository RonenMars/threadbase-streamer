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

  /**
   * Erase a device record, rather than revoking it.
   *
   * Exists because there was no way to remove one. `revoke` is a soft delete
   * that keeps the row for the audit surface, the registry lives in runtime.db,
   * and no CLI command deletes that file — so a `devices` row, including the
   * user-supplied name, was permanent. Additive: older clients never call it.
   *
   * Refuses a device that is still active. Deleting a live row frees its
   * token_hash without telling the device anything, so it would stop being
   * known rather than being refused; revoking first is what actually cuts the
   * credential. `?force=1` is the escape hatch for someone who means it.
   */
  app.delete("/:id", (c) => {
    const repo = deps.devicesRepo();
    if (!repo) {
      return c.json({ error: "Device registry is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }

    const id = c.req.param("id");
    const existing = repo.get(id);
    // Idempotent, like revoke: a client retrying after a dropped response gets
    // the same answer rather than a spurious 404.
    if (!existing) return c.json({ ok: true, alreadyDeleted: true });

    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    if (existing.revoked_at == null && !force) {
      return c.json(
        {
          error: "Revoke the device before deleting it, or pass ?force=1",
          code: "DEVICE_ACTIVE",
        },
        409,
      );
    }

    repo.delete(id);
    return c.json({ ok: true, alreadyDeleted: false });
  });

  /** Bulk erase of already-revoked devices. Safe by construction — a revoked
   *  device is already refused, so removing its row restores no access. */
  app.delete("/", (c) => {
    const repo = deps.devicesRepo();
    if (!repo) {
      return c.json({ error: "Device registry is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }
    return c.json({ ok: true, deleted: repo.deleteRevoked() });
  });

  return app;
};
