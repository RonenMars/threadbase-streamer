import { Hono } from "hono";
import type { IncomingMessage } from "http";
import { hostname } from "os";
import { getLogger } from "../../logger";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const clientLog = getLogger("client");

type ClientLogEntry = {
  level?: "debug" | "info" | "warn" | "error";
  msg?: string;
  ts?: string;
  tag?: string;
  fields?: Record<string, unknown>;
};

export const createMiscRoutes = (
  deps: Pick<ApiDeps, "publicUrl" | "sessionStore" | "ptyAttachedIds">,
) => {
  const app = new Hono<AppEnv>();

  app.get("/api/info", (c) => {
    const ptyIds = deps.ptyAttachedIds();
    return c.json({
      version: __VERSION__,
      machineName: hostname(),
      platform: process.platform,
      activeSessions: deps.sessionStore.list(ptyIds).filter((s) => s.status === "running").length,
      publicUrl: deps.publicUrl,
    });
  });

  app.get("/api/profiles", (c) => c.json([]));

  app.post("/api/push/register", (c) => c.json({ ok: true }));

  app.post("/api/__client-log", async (c) => {
    const ua = c.req.header("user-agent") ?? "";
    let body: { entries?: ClientLogEntry[] } = {};
    try {
      body = (await readJsonBody(c.env.incoming)) as { entries?: ClientLogEntry[] };
    } catch {
      return c.json({ ok: false, error: "invalid json" }, 400);
    }
    const entries = Array.isArray(body.entries) ? body.entries : [];
    for (const e of entries) {
      const level =
        e.level === "debug" || e.level === "warn" || e.level === "error" ? e.level : "info";
      clientLog[level](`[client] ${e.tag ?? "log"}: ${e.msg ?? ""}`, {
        clientTs: e.ts,
        tag: e.tag,
        ua,
        ...(e.fields ?? {}),
      });
    }
    return c.json({ ok: true, accepted: entries.length });
  });

  return app;
};
