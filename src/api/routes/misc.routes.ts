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
    "publicUrl" | "sessionStore" | "ptyAttachedIds" | "rotateApiKey" | "localNoAuth" | "pushRepo"
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
      // Capability flag: this server serves /api/config/claude-flags. Additive —
      // older clients ignore it, and clients talking to an older server see it
      // absent and hide the UI rather than 404ing.
      claudeFlags: true,
    });
  });

  app.get("/api/profiles", (c) => c.json([]));

  app.post("/api/auth/rotate", (c) => {
    // Block rotation when localNoAuth is on — any localhost process could
    // call this and lock out the legitimate owner.
    if (deps.localNoAuth) {
      return c.json({ error: "key rotation is disabled while localNoAuth is active" }, 403);
    }
    const { newKey, persisted } = deps.rotateApiKey();
    return c.json({
      apiKey: newKey,
      persisted,
      ...(persisted
        ? {}
        : {
            warning:
              "Key rotated in memory only. The server was started with --api-key, so the " +
              "old key will be restored on restart. Remove --api-key and let the server " +
              "manage the key via ~/.threadbase/server.yaml for rotation to survive restarts.",
          }),
    });
  });

  // Push registration (C7). This was a no-op returning { ok: true }: mobile
  // registered, got success, and nothing was stored — so no notification could
  // ever be delivered and no failure could be observed. The client had no way
  // to discover that its "successful" registration meant nothing.
  app.post("/api/push/register", async (c) => {
    // Read the raw Node request like the sibling routes do — Hono's c.req.json()
    // does not see a body on this server's request plumbing.
    const body = (await readJsonBody(c.env.incoming).catch(() => null)) as {
      token?: unknown;
      platform?: unknown;
      deviceId?: unknown;
    } | null;
    const token = body?.token;
    const platform = body?.platform;

    if (typeof token !== "string" || token.length === 0) {
      return c.json({ error: "Missing token" }, 400);
    }
    if (platform !== "ios" && platform !== "android") {
      return c.json({ error: "platform must be 'ios' or 'android'" }, 400);
    }

    const repo = deps.pushRepo();
    if (!repo) {
      // Report honestly rather than claiming success we cannot back — the exact
      // failure mode this endpoint used to have.
      return c.json({ error: "Push registration is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }

    repo.register({
      token,
      platform,
      deviceId: typeof body?.deviceId === "string" ? body.deviceId : null,
    });
    return c.json({ ok: true });
  });

  // Delivery health for every registered token. Never echoes a token back — it
  // is a delivery credential, and this endpoint exists to explain state, not to
  // hand out secrets.
  app.get("/api/push/health", (c) => {
    const repo = deps.pushRepo();
    if (!repo) return c.json({ tokens: [], available: false });
    return c.json({ tokens: repo.listHealth(), available: true });
  });

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
