import {
  applyIncludeFilter,
  applyPagination,
  applyProjectFilter,
  applySort,
  type Conversation,
  type ConversationMeta,
  ConversationScanner,
  type SortOrder,
  search,
} from "@threadbase/scanner";
import { existsSync, watch as fsWatch, readdirSync } from "fs";
import { realpath } from "fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { homedir } from "os";
import { join } from "path";
import pinoHttp, { type HttpLogger } from "pino-http";
import { type WebSocket, WebSocketServer } from "ws";
import {
  loadBrowseRoot,
  loadCacheDir,
  loadPublicUrl,
  loadTailSize,
  validateApiKey,
  validatePublicUrl,
} from "./auth";
import { createDirectory, listDirectories, resolveBrowsePath } from "./browse";
import { ConversationCache } from "./conversation-cache";
import { createPool, getDbConfig, maskConnectionString, runMigrations } from "./db";
import { CacheMetadataRepository } from "./db/repositories/cacheMetadata.repository";
import { ConversationsRepository } from "./db/repositories/conversations.repository";
import { ProjectsRepository } from "./db/repositories/projects.repository";
import { SessionsRepository } from "./db/repositories/sessions.repository";
import { recordUpload } from "./db/upload-records";
import { handleListProjectChats } from "./handlers/handleListProjectChats";
import { getLogger } from "./logger";
import { PairTokenStore } from "./pair-store";
import { discoverClaudeProcesses } from "./process-discovery";
import { PTYManager } from "./pty-manager";
import { seal } from "./seal";
import { ConversationWatcher } from "./services/conversations/conversationWatcher";
import { SessionStore } from "./session-store";
import type {
  DiscoveredProcess,
  ServerConfig,
  SessionSortKey,
  SortOrder as SessionSortOrder,
  SessionStatus,
} from "./types";
import { saveUploadFile } from "./uploads";
import { WSHub } from "./ws-hub";

const BROWSE_SYSTEM_PROMPT = (browseRoot: string) =>
  `You are working within the project boundary: ${browseRoot}. ` +
  `Do not read, write, or execute commands that access files or directories outside this boundary.`;

const DEFAULT_PTY_GRACE_PERIOD_MS = 270_000; // 4.5 minutes

// ─── Inline Router ─────────────────────────────────────────────────────────

type RouteParams = Record<string, string>;
type RouteHandler = (
  params: RouteParams,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
) => void | Promise<void>;

class InlineRouter {
  private routes: Array<{
    method: string;
    parts: string[];
    greedy: boolean;
    handler: RouteHandler;
  }> = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    const parts = pattern.split("/");
    const greedy = parts[parts.length - 1].startsWith("*");
    this.routes.push({ method, parts, greedy, handler });
  }

  async match(
    method: string,
    path: string,
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ): Promise<boolean> {
    const segments = path.split("/");
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const limit = route.greedy ? route.parts.length - 1 : route.parts.length;
      if (!route.greedy && segments.length !== route.parts.length) continue;
      if (route.greedy && segments.length < route.parts.length) continue;
      const params: RouteParams = {};
      let matched = true;
      for (let i = 0; i < limit; i++) {
        const pat = route.parts[i];
        if (pat.startsWith(":")) params[pat.slice(1)] = segments[i];
        else if (pat !== segments[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      if (route.greedy) {
        const key = route.parts[route.parts.length - 1].slice(1); // strip "*"
        params[key] = decodeURIComponent(segments.slice(limit).join("/"));
      }
      await route.handler(params, req, url, res);
      return true;
    }
    return false;
  }
}

export class StreamerServer {
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private ptyManager: PTYManager;
  private sessionStore: SessionStore;
  private wsHub: WSHub;
  private fileWatcher: ConversationWatcher;
  private sessionFileMap = new Map<string, string>(); // sessionId → JSONL filePath
  private scanner: ConversationScanner | null = null;
  private scannerReady: Promise<unknown> | null = null;
  private apiKey: string;
  private localNoAuth: boolean;
  private verbose: boolean;
  private scanProfiles:
    | Array<{ id: string; label: string; configDir: string; enabled: boolean; emoji: string }>
    | undefined;
  private dbPool: Awaited<ReturnType<typeof createPool>> | null = null;
  private dbInstanceId: string | null = null;
  private disableDb = false;
  private browseRoot: string | null = null;
  private publicUrl: string | null = null;
  private pairTokens = new PairTokenStore();
  private exchangeAttempts = new Map<string, number[]>();
  private ptyGracePeriodMs: number;
  // Map of sessionId → grace timer; fires to kill PTY after WS disconnect
  private ptyGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Map of sessionId → set of subscribed WS clients
  private sessionSubscribers = new Map<string, Set<WebSocket>>();
  private cache: ConversationCache | null = null;
  private projectsRepo: ProjectsRepository | null = null;
  private conversationsRepo: ConversationsRepository | null = null;
  private sessionsRepo: SessionsRepository | null = null;
  private cacheMetadataRepo: CacheMetadataRepository | null = null;
  private discoveryCache: {
    entries: DiscoveredProcess[];
    fetchedAt: number;
  } | null = null;
  private cacheDir: string;
  private tailSize: number;
  private router = new InlineRouter();
  private log = getLogger("server");
  private httpLog: HttpLogger = pinoHttp({
    logger: this.log.pino,
    customLogLevel: (_req, res, err) => {
      if (err || (res.statusCode ?? 0) >= 500) return "error";
      if ((res.statusCode ?? 0) >= 400) return "warn";
      return "info";
    },
    customProps: (req) => {
      const fwd = req.headers["x-forwarded-for"];
      const fwdFirst = Array.isArray(fwd)
        ? fwd[0]
        : (fwd as string | undefined)?.split(",")[0]?.trim();
      return { ip: fwdFirst || req.socket?.remoteAddress || "-" };
    },
  });

  constructor(config: ServerConfig & { apiKey: string }) {
    this.apiKey = config.apiKey;
    this.localNoAuth = config.localNoAuth ?? false;
    this.verbose = config.verbose ?? false;
    this.disableDb = config.disableDb ?? false;
    this.scanProfiles = config.scanProfiles;
    this.ptyGracePeriodMs = config.ptyGracePeriodMs ?? DEFAULT_PTY_GRACE_PERIOD_MS;
    this.cacheDir = config.cacheDir ?? loadCacheDir() ?? join(homedir(), ".threadbase", "cache");
    this.tailSize = config.tailSize ?? loadTailSize() ?? 10;

    const rawRoot = process.env.THREADBASE_BROWSE_ROOT ?? loadBrowseRoot() ?? config.browseRoot;
    if (rawRoot) {
      realpath(rawRoot)
        .then((resolved) => {
          this.browseRoot = resolved;
          if (this.verbose) this.log.info(`Browse root: ${resolved}`, { browseRoot: resolved });
        })
        .catch(() => {
          this.log.warn(`Warning: browse root does not exist: ${rawRoot}`, { browseRoot: rawRoot });
        });
    }

    const rawPublicUrl = process.env.THREADBASE_PUBLIC_URL ?? config.publicUrl ?? loadPublicUrl();
    if (rawPublicUrl) {
      const result = validatePublicUrl(rawPublicUrl);
      if (result.ok) {
        this.publicUrl = result.normalized;
        if (this.verbose)
          this.log.info(`Public URL: ${this.publicUrl}`, { publicUrl: this.publicUrl });
      } else {
        this.log.warn(`Warning: ${result.error}`, { error: result.error });
      }
    }

    this.sessionStore = new SessionStore();
    this.wsHub = new WSHub();

    this.fileWatcher = new ConversationWatcher({
      onNewLine: (filePath, line) => {
        this.cache?.updateFromLine(filePath, line);
        for (const [sessionId, watchedPath] of this.sessionFileMap) {
          if (watchedPath === filePath) {
            this.wsHub.broadcast({ type: "conversation_event", sessionId, line });
            break;
          }
        }
      },
    });

    this.ptyManager = new PTYManager({
      onOutput: (sessionId, data) => {
        this.wsHub.broadcast({ type: "terminal_output", sessionId, data });
      },
      onReady: (session) => {
        const resp = this.sessionStore.get(session.id, this.ptyAttachedIds());
        if (resp) this.wsHub.broadcast({ type: "session_ready", session: resp });
      },
      onStatusChange: (session) => {
        this.sessionStore.updateManaged(session.id, {
          status: session.status,
          completedAt: session.completedAt,
          ...(session.lastActivityAt != null && { lastActivityAt: session.lastActivityAt }),
        });
        // Stop watching JSONL when PTY exits (session goes idle)
        if (session.status === "idle") {
          const filePath = this.sessionFileMap.get(session.id);
          if (filePath) {
            this.fileWatcher.unwatch(filePath);
            this.sessionFileMap.delete(session.id);
          }
        }
        const resp = this.sessionStore.get(session.id, this.ptyAttachedIds());
        if (resp) {
          this.wsHub.broadcast({ type: "session_update", session: resp });
        }
      },
    });

    this.router.add("GET", "/api/conversations/*tail", (p, _q, url, res) =>
      this.handleGetConversation(p.tail, url, res),
    );
    this.router.add("GET", "/api/sessions/:id", (p, _q, _u, res) =>
      this.handleGetSession(p.id, res),
    );
    this.router.add("GET", "/api/sessions/:id/output", (p, _q, _u, res) =>
      this.handleGetOutput(p.id, res),
    );
    this.router.add("POST", "/api/sessions/:id/input", (p, req, _u, res) =>
      this.handleSendInput(p.id, req, res),
    );
    this.router.add("POST", "/api/sessions/:id/files", (p, req, _u, res) =>
      this.handleUploadFile(p.id, req, res),
    );
    this.router.add("POST", "/api/sessions/:id/cancel", (p, _q, _u, res) =>
      this.handleCancel(p.id, res),
    );
    this.router.add("PATCH", "/api/sessions/:id/name", (p, req, _u, res) =>
      this.handleSetSessionName(p.id, req, res),
    );
    this.router.add("POST", "/api/sessions/:id/adopt", (p, _q, _u, res) =>
      this.handleAdopt(p.id, res),
    );

    this.httpServer = createServer((req, res) => this.handleRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (req, socket, head) => {
      if (!this.authenticate(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wsHub.addClient(ws);

        const sessions = this.sessionStore.list(this.ptyAttachedIds());
        ws.send(JSON.stringify({ type: "session_list", sessions }));

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            // Client subscribes to a session's terminal stream
            if (msg.type === "subscribe_session" && typeof msg.sessionId === "string") {
              this.addSessionSubscriber(msg.sessionId, ws);
              if (this.ptyManager.hasSession(msg.sessionId)) {
                const lines = this.ptyManager.getOutputLines(msg.sessionId, 200);
                ws.send(
                  JSON.stringify({ type: "terminal_replay", sessionId: msg.sessionId, lines }),
                );
              }
            }
            // Client explicitly releases the session (kill PTY immediately)
            if (msg.type === "hold_session" && typeof msg.sessionId === "string") {
              this.startGraceTimer(msg.sessionId, 0);
            }
          } catch {
            // malformed JSON, ignore
          }
        });

        ws.on("close", () => {
          // Start grace timers for all sessions this client was subscribed to
          for (const [sessionId, subscribers] of this.sessionSubscribers) {
            subscribers.delete(ws);
            if (subscribers.size === 0) {
              this.startGraceTimer(sessionId, this.ptyGracePeriodMs);
            }
          }
        });
      });
    });
  }

  // ─── PTY Grace Timer ────────────────────────────────────────────

  private ptyAttachedIds(): Set<string> {
    return new Set(this.ptyManager.listSessions().map((s) => s.id));
  }

  private addSessionSubscriber(sessionId: string, ws: WebSocket): void {
    let subs = this.sessionSubscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.sessionSubscribers.set(sessionId, subs);
    }
    subs.add(ws);
    // Cancel any pending grace timer since someone is now watching
    const existing = this.ptyGraceTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.ptyGraceTimers.delete(sessionId);
    }
  }

  private startGraceTimer(sessionId: string, delayMs: number): void {
    const existing = this.ptyGraceTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.ptyGraceTimers.delete(sessionId);
      this.sessionSubscribers.delete(sessionId);
      if (this.ptyManager.hasSession(sessionId)) {
        this.log.info(
          `[grace] killing idle PTY for ${sessionId}`,
          { sessionId, event: "pty.grace_kill" },
          "pino",
        );
        this.ptyManager.putOnHold(sessionId);
        const resp = this.sessionStore.get(sessionId, this.ptyAttachedIds());
        if (resp) this.wsHub.broadcast({ type: "session_update", session: resp });
      }
    }, delayMs);

    this.ptyGraceTimers.set(sessionId, timer);
  }

  async listen(port: number, opts?: { awaitReady?: boolean }): Promise<void> {
    // DB is still used for upload records and other non-session purposes.
    // Session state is no longer persisted to DB.
    const dbConfig = this.disableDb ? null : getDbConfig();
    if (dbConfig) {
      this.dbPool = await createPool(dbConfig);
      this.dbInstanceId = dbConfig.instanceId;
      const masked = maskConnectionString(dbConfig.connectionString);
      this.log.info(`Database enabled: ${masked}`, {
        connectionString: masked,
        instanceId: dbConfig.instanceId,
      });
      this.log.info(`Instance ID: ${dbConfig.instanceId}`, { instanceId: dbConfig.instanceId });
      await runMigrations(this.dbPool);
      this.log.info("Database migrations applied", { event: "db.migrations_applied" });
    }

    const warmUp = new Promise<void>((resolveWarm) => {
      this.httpServer.listen(port, () => {
        this.log.info(`Streamer server listening on port ${port}`, {
          port,
          event: "server.listening",
        });
        try {
          this.cache = ConversationCache.open(join(this.cacheDir, "cache.db"), this.tailSize);
          const db = this.cache.getDatabase();
          this.projectsRepo = new ProjectsRepository(db);
          this.conversationsRepo = new ConversationsRepository(this.cache);
          this.sessionsRepo = new SessionsRepository(this.sessionStore);
          this.cacheMetadataRepo = new CacheMetadataRepository(db);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(`ConversationCache failed to open (running without cache): ${message}`, {
            error: message,
            event: "cache.open_failed",
          });
        }
        this.getScanner()
          .then(async (scanner) => {
            if (!this.cache) return;
            const metas = [...scanner.getMetadataCache().values()] as any[];
            this.cache.upsertFromScannerMeta(metas);
            const BATCH = 50;
            for (let i = 0; i < metas.length; i += BATCH) {
              const batch = metas.slice(i, i + BATCH);
              for (const m of batch) {
                if (m.filePath) {
                  const id =
                    m.sessionId ||
                    m.id
                      ?.split("/")
                      .pop()
                      ?.replace(/\.jsonl$/, "") ||
                    m.id;
                  this.cache.populateTailFromFile(id, m.filePath);
                }
              }
              await new Promise<void>((r) => setImmediate(r));
            }
          })
          .catch(() => {})
          .finally(() => resolveWarm());
      });
    });
    if (opts?.awaitReady) await warmUp;
  }

  async close(): Promise<void> {
    for (const timer of this.ptyGraceTimers.values()) clearTimeout(timer);
    this.ptyGraceTimers.clear();
    this.cache?.close();
    this.ptyManager.dispose();
    this.fileWatcher.dispose();
    this.wsHub.dispose();
    this.pairTokens.dispose();
    if (this.dbPool) {
      await this.dbPool.end();
    }
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  // ─── Request Router ────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    this.httpLog(req, res);

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    const isPublicRoute =
      (method === "POST" && path === "/api/pair/exchange") ||
      (method === "GET" && path === "/healthz");
    if (!isPublicRoute && !this.authenticate(req)) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      if (method === "GET" && path === "/healthz")
        return json(res, 200, { ok: true, version: __VERSION__ });
      if (method === "GET" && path === "/api/info") return this.handleInfo(res);
      if (method === "GET" && path === "/api/profiles") return json(res, 200, []);
      if (method === "POST" && path === "/api/push/register") return json(res, 200, { ok: true });
      if (method === "POST" && path === "/api/pair/start") return this.handlePairStart(res);
      if (method === "POST" && path === "/api/pair/exchange")
        return await this.handlePairExchange(req, res);
      if (method === "GET" && path === "/api/conversations")
        return await this.handleListConversations(url, res);
      if (method === "GET" && path === "/api/conversations/count")
        return await this.handleConversationsCount(url, res);
      if (method === "GET" && path === "/api/projects/popular")
        return this.handleGetPopularProjects(url, res);
      if (method === "GET" && path === "/api/search") return await this.handleSearch(url, res);
      if (method === "GET" && path === "/api/sessions")
        return await this.handleListSessions(url, res);
      if (method === "GET" && path === "/api/sessions/count") return this.handleSessionsCount(res);
      if (method === "GET" && path === "/api/sessions/recents")
        return this.handleGetRecentSessions(url, res);
      if (method === "GET" && path === "/api/sessions/names")
        return this.handleGetSessionNames(res);
      if (method === "GET" && path === "/project-chats")
        return this.handleListProjectChats(url, res);
      if (method === "POST" && path === "/api/sessions/resume")
        return await this.handleResume(req, res);
      if (method === "GET" && path === "/api/browse") return await this.handleBrowse(url, res);
      if (method === "POST" && path === "/api/browse/mkdir")
        return await this.handleMkdir(req, res);
      if (method === "POST" && path === "/api/sessions/start")
        return await this.handleStartSession(req, res);

      if (!(await this.router.match(method, path, req, url, res))) {
        json(res, 404, { error: "Not found" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      json(res, 500, { error: message });
    }
  }

  // ─── Auth ──────────────────────────────────────────────────────

  private authenticate(req: IncomingMessage): boolean {
    if (this.localNoAuth && isLocalRequest(req)) return true;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return validateApiKey(authHeader.slice(7), this.apiKey);
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const key = url.searchParams.get("key");
    if (key) return validateApiKey(key, this.apiKey);

    return false;
  }

  // ─── Handlers ──────────────────────────────────────────────────

  private handleInfo(res: ServerResponse): void {
    const { hostname } = require("os");
    const ptyIds = this.ptyAttachedIds();
    json(res, 200, {
      version: __VERSION__,
      machineName: hostname(),
      platform: process.platform,
      activeSessions: this.sessionStore.list(ptyIds).filter((s: any) => s.status === "running")
        .length,
      publicUrl: this.publicUrl,
    });
  }

  private handlePairStart(res: ServerResponse): void {
    const minted = this.pairTokens.mint();
    json(res, 200, {
      token: minted.token,
      expiresAt: minted.expiresAt,
      expiresInSeconds: minted.expiresInSeconds,
      publicUrl: this.publicUrl,
    });
  }

  private async handlePairExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ct = req.headers["content-type"] ?? "";
    if (!String(ct).toLowerCase().includes("application/json")) {
      json(res, 415, { error: "Content-Type: application/json required" });
      return;
    }

    const ip = req.socket.remoteAddress ?? "unknown";
    if (!this.checkExchangeRateLimit(ip)) {
      json(res, 429, { error: "Too many pair exchange attempts; try again in a minute" });
      return;
    }

    let body: any;
    try {
      body = await readBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid body";
      json(res, 400, { error: message });
      return;
    }

    const { token, clientPublicKey } = body ?? {};
    if (typeof token !== "string" || typeof clientPublicKey !== "string") {
      json(res, 400, { error: "Missing token or clientPublicKey" });
      return;
    }

    const result = this.pairTokens.consume(token);
    if (!result.ok) {
      json(res, 401, { error: `Pair token ${result.reason}` });
      return;
    }

    let sealed: ReturnType<typeof seal>;
    try {
      sealed = seal(this.apiKey, clientPublicKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid clientPublicKey";
      json(res, 400, { error: message });
      return;
    }

    const { hostname } = require("os");
    const ts = new Date().toISOString();
    this.log.info(`[pair] token exchanged from ${ip} at ${ts}`, {
      event: "pair.token_exchanged",
      ip,
      ts,
    });

    json(res, 200, {
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      ephemeralPublicKey: sealed.ephemeralPublicKey,
      publicUrl: this.publicUrl,
      machineName: hostname(),
    });
  }

  private checkExchangeRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const limit = 5;
    const arr = (this.exchangeAttempts.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.exchangeAttempts.set(ip, arr);
      return false;
    }
    arr.push(now);
    this.exchangeAttempts.set(ip, arr);
    return true;
  }

  private async handleListConversations(url: URL, res: ServerResponse): Promise<void> {
    const limit = intParam(url, "limit", 50);
    const offset = intParam(url, "offset", 0);
    const sort = (url.searchParams.get("sort") ?? "recent") as SortOrder;
    const project = url.searchParams.get("project") ?? undefined;
    const bustCache = url.searchParams.get("refresh") === "1";

    if (bustCache) {
      this.cache?.invalidate();
      this.scanner = null;
      this.scannerReady = null;
    }

    if (this.cache && !bustCache) {
      const { conversations, total } = this.cache.listConversations({ project, limit, offset });
      const adapted = conversations.map((c) => ({
        id: c.id,
        title: c.projectName,
        sessionName: undefined as string | undefined,
        filePath: c.filePath,
        projectPath: c.projectPath,
        branch: c.branch ?? undefined,
        account: c.account ?? undefined,
        preview: c.preview ?? undefined,
        messageCount: c.messageCount,
        lastActivity: c.lastActivity,
        firstMessage: c.firstMessage ? (JSON.parse(c.firstMessage) as unknown) : undefined,
        lastMessage: c.lastMessage ? (JSON.parse(c.lastMessage) as unknown) : undefined,
        model: c.model ?? undefined,
      }));
      json(res, 200, { conversations: adapted, hasMore: offset + limit < total, offset, total });
      return;
    }

    const scanner = await this.getScanner();
    let metas = [...scanner.getMetadataCache().values()];
    metas = applyIncludeFilter(metas, "conversations");
    if (project) metas = applyProjectFilter(metas, project);
    metas = applySort(metas, sort);
    const total = metas.length;
    const page = applyPagination(metas, limit, offset);

    const adapted = (page.items as ConversationMeta[]).map((c) => ({
      id:
        c.sessionId ||
        c.id
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "") ||
        c.id,
      title: c.projectName,
      sessionName: c.sessionName || undefined,
      filePath: c.filePath,
      projectPath: c.projectPath,
      branch: c.gitBranch ?? undefined,
      account: c.account,
      preview: c.preview || undefined,
      messageCount: c.messageCount,
      lastActivity: c.timestamp,
      firstMessage: c.firstMessage ?? undefined,
      lastMessage: c.lastMessage ?? undefined,
      model: c.model ?? undefined,
    }));
    json(res, 200, { conversations: adapted, hasMore: offset + limit < total, offset, total });

    if (this.cache && bustCache) {
      try {
        this.cache.upsertFromScannerMeta([...scanner.getMetadataCache().values()] as any[]);
      } catch {
        // Best-effort; response already sent
      }
    }
  }

  private async handleConversationsCount(url: URL, res: ServerResponse): Promise<void> {
    const project = url.searchParams.get("project") ?? undefined;
    const bustCache = url.searchParams.get("refresh") === "1";

    if (bustCache) {
      this.cache?.invalidate();
      this.scanner = null;
      this.scannerReady = null;
    }

    if (this.cache && !bustCache) {
      const { total } = this.cache.listConversations({ project, limit: 0, offset: 0 });
      json(res, 200, { total });
      return;
    }

    const scanner = await this.getScanner();
    let metas = [...scanner.getMetadataCache().values()];
    metas = applyIncludeFilter(metas, "conversations");
    if (project) metas = applyProjectFilter(metas, project);
    json(res, 200, { total: metas.length });
  }

  private handleSessionsCount(res: ServerResponse): void {
    json(res, 200, { total: this.sessionStore.list(this.ptyAttachedIds()).length });
  }

  private handleGetRecentSessions(url: URL, res: ServerResponse): void {
    const limit = intParam(url, "limit", 20);
    const all = this.sessionStore.list(this.ptyAttachedIds());
    const sorted = [...all].sort((a, b) => {
      const aTime = a.lastActivityAt
        ? new Date(a.lastActivityAt).getTime()
        : new Date(a.startedAt).getTime();
      const bTime = b.lastActivityAt
        ? new Date(b.lastActivityAt).getTime()
        : new Date(b.startedAt).getTime();
      return bTime - aTime;
    });
    const sessions = sorted.slice(0, limit);
    json(res, 200, { sessions, total: sessions.length });
  }

  private handleGetPopularProjects(url: URL, res: ServerResponse): void {
    const limit = intParam(url, "limit", 20);
    if (!this.cache) {
      json(res, 200, { projects: [], total: 0 });
      return;
    }
    const projects = this.cache.getPopularProjects(limit);
    json(res, 200, { projects, total: projects.length });
  }

  private handleListProjectChats(url: URL, res: ServerResponse): void {
    if (
      !this.cache ||
      !this.projectsRepo ||
      !this.conversationsRepo ||
      !this.sessionsRepo ||
      !this.cacheMetadataRepo
    ) {
      json(res, 503, { error: "Cache not available" });
      return;
    }

    handleListProjectChats(url, res, {
      cache: this.cache,
      projectsRepo: this.projectsRepo,
      conversationsRepo: this.conversationsRepo,
      sessionsRepo: this.sessionsRepo,
      cacheMetadataRepo: this.cacheMetadataRepo,
      getSessionResponses: () => this.sessionStore.list(this.ptyAttachedIds()),
    });
  }

  private async getScanner(): Promise<ConversationScanner> {
    if (this.scannerReady) {
      await this.scannerReady;
      return this.scanner as ConversationScanner;
    }
    this.scanner = new ConversationScanner();
    this.scannerReady = this.scanner.scan(this.scanProfiles ? { profiles: this.scanProfiles } : {});
    await this.scannerReady;
    return this.scanner;
  }

  private findJsonlPath(uuid: string): string | null {
    const projectsDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projectsDir)) return null;
    const filename = `${uuid}.jsonl`;
    for (const dir of readdirSync(projectsDir)) {
      const fp = join(projectsDir, dir, filename);
      if (existsSync(fp)) return fp;
      const projectDir = join(projectsDir, dir);
      try {
        for (const sub of readdirSync(projectDir)) {
          const subagentPath = join(projectDir, sub, "subagents", filename);
          if (existsSync(subagentPath)) return subagentPath;
        }
      } catch {
        // Not a directory or no access
      }
    }
    return null;
  }

  private async findConversationByUuid(uuid: string): Promise<Conversation | null> {
    const scanner = await this.getScanner();
    const fromIndex = await scanner.getConversation(uuid);
    if (fromIndex) return fromIndex;

    if (this.scanProfiles) return null;

    const filePath = this.findJsonlPath(uuid);
    if (!filePath) return null;
    this.scanner = null;
    this.scannerReady = null;
    const freshScanner = await this.getScanner();
    return freshScanner.getConversation(uuid);
  }

  private async handleGetConversation(id: string, url: URL, res: ServerResponse): Promise<void> {
    // Try the scanner first (has full content including tool_use blocks).
    // Fall back to the cache tail only when the scanner can't find the file —
    // e.g. a conversation that existed in a previous run but whose JSONL was deleted.
    const conversation = await this.findConversationByUuid(id);

    if (!conversation && this.cache) {
      const isFirstLoad =
        !url.searchParams.has("msg_limit") && !url.searchParams.has("before_index");
      if (isFirstLoad) {
        const tail = this.cache.getConversationTail(id);
        if (tail && tail.messages.length > 0) {
          const cachedMeta = this.cache.getMetaById(id);
          const messagesPayload = tail.messages.map((m, idx) => ({
            message_index: idx,
            role: m.role,
            timestamp: m.timestamp,
            text: m.text,
            tool_calls: [] as unknown[],
            content: (m.content ?? []).filter((b: any) => b.type !== "text"),
          }));
          json(res, 200, {
            meta: {
              id,
              profile_id: cachedMeta?.account ?? undefined,
              project_name: cachedMeta?.projectName ?? undefined,
              project_path: cachedMeta?.projectPath ?? undefined,
              file_path: cachedMeta?.filePath ?? undefined,
              last_updated_at: cachedMeta?.lastActivity ?? undefined,
              message_count: cachedMeta?.messageCount ?? undefined,
            },
            messages: messagesPayload,
            message_pagination: {
              total: tail.tailSize,
              before_index: tail.tailSize,
              from_index: 0,
              has_more_older: false,
              next_before_index: null,
            },
          });
          return;
        }
      }
    }

    if (!conversation) {
      json(res, 404, { error: "Conversation not found" });
      return;
    }

    const filtered = conversation.messages.filter((m: any) => {
      if (m.role === "user" && m.isToolResult) return false;
      return true;
    });
    const total = filtered.length;

    const usePaging = url.searchParams.has("msg_limit") || url.searchParams.has("before_index");

    let slice = filtered;
    let fromIdx = 0;
    let messagePagination: Record<string, unknown> | undefined;

    if (usePaging) {
      const limit = Math.min(Math.max(intParam(url, "msg_limit", 80), 1), 500);
      let beforeIndex = total;
      if (url.searchParams.has("before_index")) {
        beforeIndex = intParam(url, "before_index", total);
        beforeIndex = Math.min(Math.max(beforeIndex, 0), total);
      }
      const start = Math.max(0, beforeIndex - limit);
      slice = filtered.slice(start, beforeIndex);
      fromIdx = start;
      messagePagination = {
        total,
        before_index: beforeIndex,
        from_index: start,
        has_more_older: start > 0,
        next_before_index: start > 0 ? start : null,
      };
    }

    const messagesPayload = slice.map((m: any, localIdx: number) => ({
      message_index: fromIdx + localIdx,
      role: m.role,
      timestamp: m.timestamp,
      text: m.text,
      tool_calls: m.metadata?.toolUses ?? [],
      content: [
        ...(m.metadata?.toolUseBlocks ?? []).map((b: any) => ({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input,
        })),
        ...(m.metadata?.toolResults ?? []).map((r: any) => ({
          type: "tool_result",
          tool_use_id: r.toolUseId,
          content: JSON.stringify(r.content),
          is_error: r.isError ?? false,
        })),
      ],
    }));

    const body: Record<string, unknown> = {
      meta: {
        id,
        profile_id: (conversation as any).account,
        project_name: (conversation as any).projectName,
        project_path: (conversation as any).projectPath,
        file_path: (conversation as any).filePath,
        last_updated_at: (conversation as any).timestamp,
        message_count: (conversation as any).messageCount,
      },
      messages: messagesPayload,
    };
    if (messagePagination) body.message_pagination = messagePagination;
    json(res, 200, body);
  }

  private async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams.get("q") ?? "";
    if (!q) {
      json(res, 400, { error: "Missing query parameter: q" });
      return;
    }

    const limit = intParam(url, "limit", 50);
    const results = await search(q, {
      limit,
      include: "conversations",
      ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
    });
    const adapted = results.map((r: any) => ({
      id:
        r.meta.sessionId ||
        r.meta.id
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "") ||
        r.meta.id,
      title: r.meta.projectName,
      sessionName: r.meta.sessionName || undefined,
      filePath: r.meta.filePath,
      projectPath: r.meta.projectPath,
      branch: r.meta.gitBranch ?? undefined,
      account: r.meta.account,
      preview: r.meta.preview || undefined,
      messageCount: r.meta.messageCount,
      lastActivity: r.meta.timestamp,
      firstMessage: r.meta.firstMessage ?? undefined,
      lastMessage: r.meta.lastMessage ?? undefined,
    }));
    json(res, 200, {
      conversations: adapted,
      hasMore: false,
      offset: 0,
      total: adapted.length,
    });
  }

  private async handleListSessions(url: URL, res: ServerResponse): Promise<void> {
    const DISCOVERY_TTL_MS = 15_000;
    const now = Date.now();

    if (!this.discoveryCache || now - this.discoveryCache.fetchedAt >= DISCOVERY_TTL_MS) {
      try {
        const discovered = await discoverClaudeProcesses();
        this.sessionStore.setDiscovered(discovered);
        this.discoveryCache = { entries: discovered, fetchedAt: now };
      } catch {
        // Discovery is best-effort
      }
    }

    // Backwards compat: a bare GET /api/sessions returns the legacy plain
    // array. Any pagination param switches to the new envelope.
    const hasPaginationParams =
      url.searchParams.has("limit") ||
      url.searchParams.has("cursor") ||
      url.searchParams.has("sortBy") ||
      url.searchParams.has("order") ||
      url.searchParams.has("status");

    if (!hasPaginationParams) {
      json(res, 200, this.sessionStore.list(this.ptyAttachedIds()));
      return;
    }

    const parsed = parseSessionListQuery(url);
    if ("error" in parsed) {
      json(res, 400, { error: parsed.error });
      return;
    }

    try {
      const page = this.sessionStore.paginate(this.ptyAttachedIds(), parsed.query);
      json(res, 200, page);
    } catch (err) {
      if (err instanceof Error && err.message === "INVALID_CURSOR") {
        json(res, 400, { error: "Invalid cursor" });
        return;
      }
      throw err;
    }
  }

  private handleGetSession(sessionId: string, res: ServerResponse): void {
    const session = this.sessionStore.get(sessionId, this.ptyAttachedIds());
    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }
    if (!existsSync(session.projectPath)) {
      session.failureReason = `Project directory not found: ${session.projectPath}`;
    }
    json(res, 200, session);
  }

  private async handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.discoveryCache = null;
    const body = await readBody(req);
    // Accept both sessionId (new) and conversationId (legacy alias)
    const sessionId: string | undefined = body.sessionId ?? body.conversationId;
    const explicitPath: string | undefined = body.projectPath;

    if (!sessionId) {
      json(res, 400, { error: "Missing sessionId" });
      return;
    }

    // If a PTY is already running for this session, return it immediately
    if (this.ptyManager.hasSession(sessionId)) {
      const resp = this.sessionStore.get(sessionId, this.ptyAttachedIds());
      if (resp) {
        json(res, 200, resp);
        return;
      }
    }

    const conv = await this.findConversationByUuid(sessionId);
    const projectPath: string = explicitPath ?? (conv as any)?.projectPath;
    if (!projectPath) {
      if (!conv) {
        json(res, 404, { error: "Conversation not found" });
        return;
      }
      json(res, 400, { error: "Could not determine project path" });
      return;
    }

    const session = await this.ptyManager.start(sessionId, {
      projectPath,
      projectName: body.projectName,
      branch: body.branch,
    });

    // Enrich session with conversation metadata
    if (conv) {
      session.sessionName = (conv as any).sessionName ?? undefined;
      session.messageCount = (conv as any).messageCount ?? 0;
      session.account = (conv as any).account ?? undefined;
      session.filePath = (conv as any).filePath ?? undefined;

      const scanner = await this.getScanner();
      const meta = conv.filePath ? scanner.getMetadataCache().get(conv.filePath) : undefined;
      if (meta) {
        session.model = meta.model ?? undefined;
        session.preview = meta.preview ?? undefined;
        session.firstMessageText = meta.firstMessage?.text ?? undefined;
        session.firstMessageAt = meta.firstMessage?.timestamp
          ? new Date(meta.firstMessage.timestamp)
          : undefined;
        session.lastMessageText = meta.lastMessage?.text ?? undefined;
        session.lastMessageAt = meta.lastMessage?.timestamp
          ? new Date(meta.lastMessage.timestamp)
          : undefined;
      }
    }

    // Resolve projectId from the conversation if available; fall back to
    // an upsert from the session's projectPath when the conversation has
    // no project_id yet (self-heals during resume).
    if (this.cache && this.projectsRepo && this.conversationsRepo) {
      let resolvedProjectId: string | null = null;
      const cachedConv = this.cache.getMetaById(sessionId);
      if (cachedConv?.projectId) {
        resolvedProjectId = cachedConv.projectId;
      } else {
        const project = this.projectsRepo.upsertProjectByPath(projectPath);
        resolvedProjectId = project.id;
        this.conversationsRepo.updateConversationProjectId({
          conversationId: sessionId,
          projectId: project.id,
        });
      }
      if (resolvedProjectId) {
        session.projectId = resolvedProjectId;
        session.resumedFromConversationId = sessionId;
      }
    }

    this.sessionStore.addManaged(session);

    // Watch the conversation's JSONL file for structured events
    void this.watchConversationFile(sessionId);

    const resp = this.sessionStore.get(session.id, this.ptyAttachedIds());
    this.wsHub.broadcast({
      type: "session_list",
      sessions: this.sessionStore.list(this.ptyAttachedIds()),
    });

    json(res, 201, resp ?? session);
  }

  private async handleSendInput(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    const { input } = body;

    if (typeof input !== "string") {
      json(res, 400, { error: "Missing input field" });
      return;
    }

    try {
      const promptCount = this.ptyManager.sendInput(sessionId, input);
      this.sessionStore.updateManaged(sessionId, { promptCount });
      const updated = this.sessionStore.get(sessionId, this.ptyAttachedIds());
      if (updated) {
        this.wsHub.broadcast({ type: "session_update", session: updated });
      }
      json(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send input";
      json(res, 400, { error: message });
    }
  }

  private async handleUploadFile(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const session = this.sessionStore.get(sessionId, this.ptyAttachedIds());
    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }
    if (!session.projectPath) {
      json(res, 400, { error: "Session has no project path" });
      return;
    }

    const body = await readBody(req);
    const { filename, mimeType, dataBase64 } = body ?? {};
    if (
      typeof filename !== "string" ||
      typeof mimeType !== "string" ||
      typeof dataBase64 !== "string"
    ) {
      json(res, 400, { error: "Missing filename, mimeType, or dataBase64" });
      return;
    }

    try {
      const saved = await saveUploadFile({
        sessionId,
        projectPath: session.projectPath,
        originalName: filename,
        mimeType,
        dataBase64,
      });

      try {
        await recordUpload(this.dbPool, this.dbInstanceId, {
          id: saved.id,
          sessionId,
          filePath: saved.filePath,
          originalName: saved.originalName,
          mimeType: saved.mimeType,
          sizeBytes: saved.sizeBytes,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `[uploads] DB record failed: ${message}`,
          { event: "uploads.db_record_failed", error: message },
          "pino",
        );
      }

      json(res, 201, {
        id: saved.id,
        path: saved.filePath,
        originalName: saved.originalName,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      json(res, 400, { error: message });
    }
  }

  private handleGetOutput(sessionId: string, res: ServerResponse): void {
    // Return PTY ring buffer if a PTY is attached; otherwise return empty
    // so clients render "no buffered output" instead of an error.
    try {
      const output = this.ptyManager.getOutput(sessionId);
      json(res, 200, { output });
    } catch {
      json(res, 200, { output: "" });
    }
  }

  private handleCancel(sessionId: string, res: ServerResponse): void {
    this.discoveryCache = null;
    try {
      this.ptyManager.cancel(sessionId);
      json(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to cancel";
      json(res, 400, { error: message });
    }
  }

  private async handleAdopt(sessionId: string, res: ServerResponse): Promise<void> {
    // Refresh discovery so we have the latest metadata
    const discovered = await discoverClaudeProcesses();
    this.sessionStore.setDiscovered(discovered);
    this.discoveryCache = null;

    const discSession = this.sessionStore.get(sessionId, this.ptyAttachedIds());
    if (!discSession || discSession.ptyAttached) {
      json(res, 404, { error: "Discovered session not found" });
      return;
    }

    const { projectPath, projectName, branch } = discSession;
    const convId = discSession.id;

    if (discSession.pid == null) {
      json(res, 400, { error: "Session has no known PID" });
      return;
    }

    // Kill the external process
    this.ptyManager.killPid(discSession.pid);

    // Start a new managed session, resuming the conversation
    const session = await this.ptyManager.start(convId, {
      projectPath,
      projectName,
      branch,
    });

    this.sessionStore.addManaged(session);
    void this.watchConversationFile(session.id);

    this.wsHub.broadcast({
      type: "session_list",
      sessions: this.sessionStore.list(this.ptyAttachedIds()),
    });

    json(res, 201, { sessionId: session.id });
  }

  private async handleStartSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.browseRoot) {
      json(res, 403, {
        error: "File browsing not configured. Set browseRoot on the server.",
        code: "BROWSE_ROOT_NOT_SET",
      });
      return;
    }
    const body = await readBody(req);
    const { path: relativePath } = body;

    if (typeof relativePath !== "string") {
      json(res, 400, { error: "Missing path field" });
      return;
    }

    let resolvedPath: string;
    try {
      resolvedPath = await resolveBrowsePath(this.browseRoot, relativePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid path";
      json(res, 400, { error: message });
      return;
    }

    this.discoveryCache = null;

    try {
      const session = await this.ptyManager.startFresh({
        projectPath: resolvedPath,
        projectName: body.projectName,
        systemPrompt: BROWSE_SYSTEM_PROMPT(this.browseRoot),
      });

      this.sessionStore.addManaged(session);

      // Return the real UUID immediately — no pending_ dance needed.
      json(res, 202, { id: session.id, status: "pending" });

      // Wire up JSONL watching once Claude creates the conversation file.
      this.watchForJsonl(session.id, resolvedPath);

      this.wsHub.broadcast({
        type: "session_list",
        sessions: this.sessionStore.list(this.ptyAttachedIds()),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start session";
      this.log.error(`[start] failed to start session: ${message}`, {
        event: "session.start_failed",
        error: message,
      });
      json(res, 500, { error: message });
    }
  }

  // ─── Project linking ─────────────────────────────────────────────

  private linkSessionToProject(sessionId: string, projectPath: string, filePath: string): void {
    if (!this.projectsRepo || !this.conversationsRepo || !this.sessionsRepo || !this.cache) {
      return;
    }
    try {
      const project = this.projectsRepo.upsertProjectByPath(projectPath, {
        lastConversationId: sessionId,
        lastConversationCreatedAt: new Date().toISOString(),
      });
      // The conversation row may not exist yet (Claude is still writing the
      // JSONL). Best-effort: only link if the row is present.
      if (this.cache.hasConversation(sessionId)) {
        this.conversationsRepo.updateConversationProjectId({
          conversationId: sessionId,
          projectId: project.id,
        });
      }
      this.sessionsRepo.updateSessionProjectId({
        sessionId,
        projectId: project.id,
      });
      if (this.cacheMetadataRepo) {
        this.cacheMetadataRepo.setCacheMetadata("last_conversation_id", sessionId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`[projects] failed to link session to project: ${message}`, {
        event: "session.project_link_failed",
        sessionId,
        projectPath,
        filePath,
        error: message,
      });
    }
  }

  // ─── File Watcher Wiring ─────────────────────────────────────────

  private async watchConversationFile(sessionId: string): Promise<void> {
    try {
      const conversation = await this.findConversationByUuid(sessionId);
      if (conversation?.filePath) {
        this.sessionFileMap.set(sessionId, conversation.filePath);
        this.fileWatcher.watch(conversation.filePath);
      }
    } catch {
      // Best-effort: if we can't find the JSONL file, raw terminal output still works
    }
  }

  // Watch the project directory for the JSONL file Claude creates for sessionId.
  // Once found, wire up structured event streaming. No rekeying needed — the UUID
  // was passed to Claude via --session-id so the filename matches from the start.
  private watchForJsonl(sessionId: string, projectPath: string): void {
    const encoded = projectPath.replace(/[/\\:.]/g, "-");
    const projectsDir = join(homedir(), ".claude", "projects", encoded);
    const expectedFile = `${sessionId}.jsonl`;
    const filePath = join(projectsDir, expectedFile);
    const deadline = Date.now() + 120_000;

    let watcher: ReturnType<typeof fsWatch> | null = null;
    const cleanup = () => {
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
    };

    const tryWire = () => {
      if (!this.ptyManager.hasSession(sessionId)) {
        cleanup();
        return;
      }
      if (Date.now() > deadline) {
        cleanup();
        return;
      }
      if (!existsSync(filePath)) return;

      cleanup();
      this.sessionFileMap.set(sessionId, filePath);
      this.fileWatcher.watch(filePath);
      this.scanner = null;
      this.scannerReady = null;
      this.linkSessionToProject(sessionId, projectPath, filePath);
      this.log.info(
        `[startFresh] wired JSONL for ${sessionId}`,
        { event: "session.jsonl_wired", sessionId, filePath },
        "pino",
      );
    };

    tryWire();
    if (this.sessionFileMap.has(sessionId)) return; // already found

    try {
      require("fs").mkdirSync(projectsDir, { recursive: true });
      watcher = fsWatch(projectsDir, tryWire);
      watcher.on("error", cleanup);
    } catch {
      // fs.watch not available (e.g. in tests), ignore
    }
  }

  private async handleBrowse(url: URL, res: ServerResponse): Promise<void> {
    if (!this.browseRoot) {
      json(res, 403, {
        error: "File browsing not configured. Set browseRoot on the server.",
        code: "BROWSE_ROOT_NOT_SET",
      });
      return;
    }
    const relativePath = url.searchParams.get("path") ?? "";
    try {
      const resolved = await resolveBrowsePath(this.browseRoot, relativePath);
      const directories = await listDirectories(resolved);
      json(res, 200, { path: relativePath, directories });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Browse failed";
      json(res, 400, { error: message });
    }
  }

  private async handleMkdir(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.browseRoot) {
      json(res, 403, {
        error: "File browsing not configured. Set browseRoot on the server.",
        code: "BROWSE_ROOT_NOT_SET",
      });
      return;
    }
    const body = await readBody(req);
    const { path: relativePath, name } = body;
    if (!name || typeof name !== "string") {
      json(res, 400, { error: "Missing name field" });
      return;
    }
    try {
      const parentPath = await resolveBrowsePath(this.browseRoot, relativePath ?? "");
      await createDirectory(parentPath, name);
      const parentRelative = relativePath ?? "";
      const created = parentRelative ? `${parentRelative}/${name}` : name;
      json(res, 201, { created });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create directory";
      if (message.includes("already exists")) {
        json(res, 409, { error: message });
      } else if (message.includes("Invalid directory name")) {
        json(res, 400, { error: message });
      } else {
        json(res, 400, { error: message });
      }
    }
  }

  private async handleSetSessionName(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.cache) {
      json(res, 503, { error: "Cache not available" });
      return;
    }
    let parsed: { name?: string };
    try {
      parsed = await readBody(req);
    } catch {
      json(res, 400, { error: "Invalid JSON" });
      return;
    }
    const name = parsed.name?.trim();
    if (!name) {
      json(res, 400, { error: "name is required" });
      return;
    }
    this.cache.upsertSessionName(sessionId, name);
    json(res, 200, { ok: true });
  }

  private handleGetSessionNames(res: ServerResponse): void {
    if (!this.cache) {
      json(res, 200, {});
      return;
    }
    json(res, 200, this.cache.listSessionNames());
  }
}

// ─── Utilities ─────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function intParam(url: URL, name: string, defaultValue: number): number {
  const val = url.searchParams.get(name);
  if (!val) return defaultValue;
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

const VALID_SORT_KEYS: SessionSortKey[] = ["startedAt", "lastActivityAt", "projectName", "status"];
const VALID_ORDERS: SessionSortOrder[] = ["asc", "desc"];
const VALID_STATUSES: SessionStatus[] = ["running", "waiting_input", "idle"];

const SESSIONS_DEFAULT_LIMIT = 200;
const SESSIONS_MAX_LIMIT = 500;

type ParsedSessionListQuery = { query: import("./types").SessionListQuery } | { error: string };

function parseSessionListQuery(url: URL): ParsedSessionListQuery {
  const limitRaw = url.searchParams.get("limit");
  let limit = SESSIONS_DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > SESSIONS_MAX_LIMIT) {
      return { error: `limit must be 1..${SESSIONS_MAX_LIMIT}` };
    }
    limit = n;
  }

  const sortByRaw = url.searchParams.get("sortBy") ?? "startedAt";
  if (!VALID_SORT_KEYS.includes(sortByRaw as SessionSortKey)) {
    return { error: `sortBy must be one of ${VALID_SORT_KEYS.join(",")}` };
  }
  const sortBy = sortByRaw as SessionSortKey;

  const orderRaw = url.searchParams.get("order") ?? "desc";
  if (!VALID_ORDERS.includes(orderRaw as SessionSortOrder)) {
    return { error: `order must be asc or desc` };
  }
  const order = orderRaw as SessionSortOrder;

  const statusRaw = url.searchParams.get("status");
  let status: SessionStatus[] | undefined;
  if (statusRaw) {
    const parts = statusRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      if (!VALID_STATUSES.includes(p as SessionStatus)) {
        return { error: `status entry "${p}" is invalid` };
      }
    }
    status = parts as SessionStatus[];
  }

  const cursor = url.searchParams.get("cursor") ?? undefined;

  return { query: { limit, sortBy, order, status, cursor } };
}

function isLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function readBody(req: IncomingMessage): Promise<any> {
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
