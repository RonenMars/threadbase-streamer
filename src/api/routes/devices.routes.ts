import { Hono } from "hono";
import { contextRegistry } from "../../e2ee/context";
import { getLogger } from "../../logger";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const log = getLogger("e2ee");

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
export const createDeviceRoutes = (deps: Pick<ApiDeps, "devicesRepo" | "wsHub">) => {
  const app = new Hono<AppEnv>();

  /**
   * Make a revocation reach the live process, not just the next request.
   *
   * `destroyDevice` drops every context the device still has indexed — N socket
   * contexts, its REST context, and any unconsumed tickets. The hub closes by
   * device identity rather than that answer because it can still own a socket
   * whose context aged out of the registry's drain. Until this line existed, a
   * revoked device kept a live encrypted socket, with its traffic keys resident
   * in this process, until the peer happened to go away (design.md §4.4).
   */
  const cutLiveContexts = (deviceId: string): void => {
    const destroyed = contextRegistry().destroyDevice(deviceId);
    const sockets = deps.wsHub.closeDevice(deviceId);
    if (destroyed.socketCtxIds.length || destroyed.restCtxIds.length || destroyed.tickets) {
      log.info("[e2ee] revocation destroyed a device's live contexts", {
        event: "e2ee.device_contexts_destroyed",
        sockets,
        rest: destroyed.restCtxIds.length,
        tickets: destroyed.tickets,
      });
    }
  };

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
      cutLiveContexts(id);
      return c.json({ ok: true, alreadyRevoked: true });
    }

    repo.revoke(id);
    cutLiveContexts(id);
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
    if (!existing) {
      cutLiveContexts(id);
      return c.json({ ok: true, alreadyDeleted: true });
    }

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
    // Same reason as revoke, and the reason it is here too: `?force=1` erases
    // an ACTIVE row, so without this the credential is gone from the store
    // while its sealed socket carries on with keys the store can no longer
    // name. Erasing a device is at least as strong as revoking it.
    cutLiveContexts(id);
    return c.json({ ok: true, alreadyDeleted: false });
  });

  /** Bulk erase of already-revoked devices. */
  app.delete("/", (c) => {
    const repo = deps.devicesRepo();
    if (!repo) {
      return c.json({ error: "Device registry is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }
    const revokedIds = repo
      .list()
      .filter((device) => device.revokedAt != null)
      .map((device) => device.deviceId);
    const deleted = repo.deleteRevoked();
    for (const deviceId of revokedIds) cutLiveContexts(deviceId);
    return c.json({ ok: true, deleted });
  });

  return app;
};
