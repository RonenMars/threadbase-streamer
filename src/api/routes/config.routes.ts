import { Hono } from "hono";
import type { IncomingMessage } from "http";
import { ClaudeFlagsBodySchema } from "../../schemas/claudeFlags.schema";
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

export const createConfigRoutes = (
  deps: Pick<ApiDeps, "claudeFlagsConfig" | "setClaudeFlagsConfig" | "localNoAuth">,
) => {
  const app = new Hono<AppEnv>();

  // The registry ships alongside the values so a client renders the form from
  // one round-trip and can never offer a flag this server doesn't know.
  app.get("/claude-flags", (c) => c.json(deps.claudeFlagsConfig()));

  app.put("/claude-flags", async (c) => {
    // Same reasoning as POST /api/auth/rotate: under localNoAuth any process on
    // the machine can call this unauthenticated, and this endpoint can turn off
    // Claude's permission prompts for every future session. Refuse rather than
    // let a local process silently escalate the box.
    if (deps.localNoAuth) {
      return c.json({ error: "claude flag changes are disabled while localNoAuth is active" }, 403);
    }

    // Read from the raw Node stream (mirrors /api/cache/alert/resolve): Hono's
    // body helpers return empty under @hono/node-server. In tests (app.request),
    // c.env.incoming is absent — fall back to arrayBuffer().
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

    const parsed = ClaudeFlagsBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }

    try {
      const result = deps.setClaudeFlagsConfig(parsed.data.values, parsed.data.extraArgs);
      return c.json({
        ...result,
        ...(result.persisted
          ? {}
          : {
              warning:
                "Flags applied in memory only. The server was started with --claude-flag, so " +
                "the CLI values will be restored on restart. Drop the flag and let the server " +
                "manage them via ~/.threadbase/server.yaml for changes to survive restarts.",
            }),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not apply flags" }, 400);
    }
  });

  return app;
};
