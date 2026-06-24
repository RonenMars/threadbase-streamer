import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { IncomingMessage } from "http";
import { hostname } from "os";
import { loadUpdateConfig } from "../../config/update-config";
import { getLogger } from "../../logger";
import { getVersion } from "../../version";
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

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function verifyWebhookSignature(body: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
  deps: Pick<
    ApiDeps,
    "publicUrl" | "sessionStore" | "ptyAttachedIds" | "rotateApiKey" | "localNoAuth"
  >,
) => {
  const app = new Hono<AppEnv>();

  app.get("/api/info", (c) => {
    const ptyIds = deps.ptyAttachedIds();
    return c.json({
      version: getVersion(),
      machineName: hostname(),
      platform: process.platform,
      activeSessions: deps.sessionStore.list(ptyIds).filter((s) => s.status === "running").length,
      publicUrl: deps.publicUrl,
    });
  });

  app.get("/api/profiles", (c) => c.json([]));

  app.post("/api/auth/rotate", (c) => {
    // Block rotation when localNoAuth is on — any localhost process could
    // call this and lock out the legitimate owner.
    if (deps.localNoAuth) {
      return c.json({ error: "key rotation is disabled while localNoAuth is active" }, 403);
    }
    const newKey = deps.rotateApiKey();
    return c.json({ apiKey: newKey });
  });

  app.post("/api/push/register", (c) => c.json({ ok: true }));

  // Webhook for auto-update. Triggered by the release CI (or any caller that
  // knows webhook_secret) to make this server pull the new release without
  // waiting for the next poll. Enabled only when webhook_secret is set in
  // ~/.threadbase/update.yaml. HMAC-SHA256 of the raw body using that secret
  // must match the X-Threadbase-Signature header.
  app.post("/api/__update", async (c) => {
    const cfg = loadUpdateConfig();
    if (!cfg?.webhook_secret) {
      return c.json({ error: "webhook disabled" }, 404);
    }

    let body: string;
    try {
      body = await readRawBody(c.env.incoming);
    } catch {
      return c.json({ error: "could not read body" }, 400);
    }

    const sig = c.req.header("x-threadbase-signature");
    if (!verifyWebhookSignature(body, sig, cfg.webhook_secret)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const cliPath = process.argv[1];
    if (!cliPath) {
      return c.json({ error: "cannot resolve updater path" }, 500);
    }
    const child = spawn(process.execPath, [cliPath, "update", "--force"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return c.json({ accepted: true, pid: child.pid }, 202);
  });

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
