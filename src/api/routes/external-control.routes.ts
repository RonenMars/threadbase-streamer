import type { Hono } from "hono";
import { readExternalControlConfig } from "../../services/external-control/config";
import { ExternalControlGrantsRepository } from "../../services/external-control/repository";
import { ExternalControlService } from "../../services/external-control/service";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

type Deps = Pick<ApiDeps, "featureFlagsConfig" | "sessionStore" | "runtimeStore"> & {
  /** Tests inject a service; production builds one over runtime.db. */
  externalControlService?: ExternalControlService;
};

/**
 * `/api/sessions/:id/external-control`, the read-only half of Connect live.
 * A namespace of its own so nothing here can reach the managed-PTY input path.
 * With the `externalControl` flag off every route answers 404, exactly as a
 * server without the feature would.
 */
export function mountExternalControlRoutes(app: Hono<AppEnv>, deps: Deps): void {
  let grants: ExternalControlGrantsRepository | null = null;
  let service = deps.externalControlService ?? null;
  const getService = () => {
    service ??= new ExternalControlService({
      config: () => readExternalControlConfig(),
      sessionStore: deps.sessionStore,
      grants: () => {
        const store = deps.runtimeStore();
        if (!store) return null;
        grants ??= new ExternalControlGrantsRepository(store.getDatabase());
        return grants;
      },
    });
    return service;
  };
  const enabled = () => deps.featureFlagsConfig().values.externalControl === true;
  const disabled = { error: "Not found", code: "EXTERNAL_CONTROL_DISABLED" } as const;
  const noStore = { "Cache-Control": "no-store" } as const;

  app.get("/:id/external-control", async (c) => {
    if (!enabled()) return c.json(disabled, 404);
    const status = await getService().status(c.req.param("id"), c.get("principal"));
    return c.json(status, 200, noStore);
  });

  app.get("/:id/external-control/screen", async (c) => {
    if (!enabled()) return c.json(disabled, 404);
    const result = await getService().screen(c.req.param("id"), c.get("principal"));
    if (!result.ok) {
      return c.json(
        { error: result.code, code: result.code, ...(result.reason && { reason: result.reason }) },
        result.status as 403 | 409 | 503,
        noStore,
      );
    }
    return c.json({ bindingId: result.bindingId, ...result.screen }, 200, noStore);
  });
}
