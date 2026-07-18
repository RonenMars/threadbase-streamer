import { Hono } from "hono";
import type { IncomingMessage } from "http";
import { ResolveCacheAlertSchema } from "../../schemas/cacheAlert.schema";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export const createCacheAlertRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  // Full pending record (including the missing list) for building a picker.
  app.get("/", (c) => {
    const monitor = deps.cacheMonitor();
    return c.json({ pending: monitor?.pending ?? null });
  });

  app.post("/resolve", async (c) => {
    // Read from the raw Node stream (mirrors /api/__update): Hono's body helpers
    // return empty under @hono/node-server. In tests (app.request), c.env.incoming
    // is absent — fall back to arrayBuffer().
    let body: unknown;
    try {
      const incoming = c.env?.incoming;
      const raw = incoming
        ? await readRawBody(incoming)
        : Buffer.from(await c.req.arrayBuffer()).toString("utf-8");
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const parsed = ResolveCacheAlertSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }

    const monitor = deps.cacheMonitor();
    if (!monitor) return c.json({ ok: true, alreadyResolved: true });

    const { fingerprint, action, ids } = parsed.data;
    const result = await monitor.resolve(fingerprint, action, ids);

    if ("conflict" in result) {
      return c.json(
        { error: "fingerprint_mismatch", currentFingerprint: result.currentFingerprint },
        409,
      );
    }
    if ("alreadyResolved" in result) {
      return c.json({ ok: true, alreadyResolved: true });
    }
    return c.json(result);
  });

  return app;
};
