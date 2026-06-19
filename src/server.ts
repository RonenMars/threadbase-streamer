import { createNodeWebSocket } from "@hono/node-ws";
import { Connection, Client as TemporalClient } from "@temporalio/client";
import {
  applyIncludeFilter,
  applyPagination,
  applyProjectFilter,
  applySort,
  type Conversation,
  type ConversationMeta,
  ConversationScanner,
  type FileStatEntry,
  type SortOrder,
  search,
} from "@threadbase-sh/scanner";
import {
  createReadStream,
  existsSync,
  watch as fsWatch,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { realpath } from "fs/promises";
import type { Hono } from "hono";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { homedir } from "os";
import { dirname, join } from "path";
import { createInterface } from "readline";
import type { WebSocket } from "ws";
import { type AgentClient, createAgentClient } from "./agent/agent-client";
import { type AgentConfig, readAgentConfig } from "./agent/agent-config";
import { type ConversationWriter, createConversationWriter } from "./agent/conversation-writer";
import { handleSendAgentInput } from "./agent/handle-send-agent-input";
import { handleStartAgentSession } from "./agent/handle-start-agent-session";
import { type AppEnv, createHonoApp } from "./api/app";
import { ALREADY_HANDLED } from "./api/routes/sessions.routes";
import { createWsRoutes } from "./api/routes/ws.routes";
import type { ApiDeps } from "./api/types/api-deps";
import {
  loadBrowseRoot,
  loadCacheDir,
  loadPublicUrl,
  loadTailSize,
  validatePublicUrl,
} from "./auth";
import {
  BrowsePathNotFoundError,
  createDirectory,
  listDirectories,
  resolveBrowsePath,
} from "./browse";
import { ConversationCache, type ConversationListItem } from "./conversation-cache";
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
import { parseAgentEntrypointsEnv } from "./services/conversations/isAgentConversation";
import { pruneAgentConversations } from "./services/conversations/pruneAgentConversations";
import { deriveProjectChatTitle } from "./services/projectChats/deriveProjectChatTitle";
import { SessionStore } from "./session-store";
import type {
  DiscoveredProcess,
  ServerConfig,
  SessionSortKey,
  SortOrder as SessionSortOrder,
  SessionStatus,
} from "./types";
import { saveUploadFile } from "./uploads";
import { computeConversationEtag } from "./utils/conversationEtag";
import { debounce } from "./utils/debounce";
import { isScannedSnapshotStale } from "./utils/isScannedSnapshotStale";
import { createScanProgressThrottle } from "./utils/scanProgressThrottle";
import { WSHub } from "./ws-hub";

const BROWSE_SYSTEM_PROMPT = (browseRoot: string) =>
  `You are working within the project boundary: ${browseRoot}. ` +
  `Do not read, write, or execute commands that access files or directories outside this boundary.`;

const DEFAULT_PTY_GRACE_PERIOD_MS = 270_000; // 4.5 minutes

// Default OFF. Set to "1" or "true" to show Claude Agent SDK / claude-mem
// runs in /api/conversations and /project-chats.
export function parseIncludeAgentsEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off" || v === "");
}

export class StreamerServer {
  private httpServer: ReturnType<typeof createServer>;
  private ptyManager: PTYManager;
  private sessionStore: SessionStore;
  private wsHub: WSHub;
  private fileWatcher: ConversationWatcher;
  private sessionFileMap = new Map<string, string>(); // sessionId → JSONL filePath
  private scanner: ConversationScanner | null = null;
  private scannerReady: Promise<unknown> | null = null;
  // Set by onConversationChanged while a scan is in-flight; getScanner() does
  // a single rescan after the current one completes instead of restarting it.
  private scannerStale = false;
  // True only while bindWithRetry is actively retrying. The persistent
  // listener-level 'error' handler demotes EADDRINUSE to debug during this
  // window so the self-healing kickstart-relaunch race doesn't spam warn.
  private binding = false;
  private cacheReady = false;
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
  // Map of clientId → WS socket (populated by the "register" WS handshake)
  private clientIdToWs = new Map<string, WebSocket>();
  // Reverse map for cleanup on close
  private wsToClientId = new Map<WebSocket, string>();
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
  private directoryDebounceMs: number;
  // Trailing-debounced trigger that flags the scanner stale after a quiet
  // period, collapsing a burst of directory events into one rescan. Assigned
  // in the constructor body (NOT a field initializer) so directoryDebounceMs
  // is already set when debounce() captures the wait.
  private markScannerStaleDebounced!: ReturnType<typeof debounce>;
  private includeAgents: boolean;
  private agentEntrypoints: ReadonlySet<string>;
  private honoApp: Hono<AppEnv>;
  private log = getLogger("server");
  private agentConfig: AgentConfig;
  private agentClient: AgentClient | null = null;

  constructor(config: ServerConfig & { apiKey: string }) {
    this.apiKey = config.apiKey;
    this.localNoAuth = config.localNoAuth ?? false;
    this.verbose = config.verbose ?? false;
    this.disableDb = config.disableDb ?? false;
    this.scanProfiles = config.scanProfiles;
    this.ptyGracePeriodMs = config.ptyGracePeriodMs ?? DEFAULT_PTY_GRACE_PERIOD_MS;
    this.cacheDir = config.cacheDir ?? loadCacheDir() ?? join(homedir(), ".threadbase", "cache");
    this.tailSize = config.tailSize ?? loadTailSize() ?? 10;
    this.directoryDebounceMs =
      parseDirScanDebounceEnv(process.env.THREADBASE_DIR_SCAN_DEBOUNCE_MS) ??
      config.directoryScanDebounceMs ??
      1000;
    this.markScannerStaleDebounced = debounce(() => {
      if (this.scannerReady) this.scannerStale = true;
      else this.scanner = null;
    }, this.directoryDebounceMs);
    this.includeAgents = parseIncludeAgentsEnv(process.env.THREADBASE_INCLUDE_AGENTS);
    this.agentEntrypoints = parseAgentEntrypointsEnv(process.env.THREADBASE_AGENT_ENTRYPOINTS);

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
      onNewLines: (filePath, lines) => {
        // One transactional cache write for the whole batch instead of per line.
        this.cache?.updateFromLines(filePath, lines);
        for (const [sessionId, watchedPath] of this.sessionFileMap) {
          if (watchedPath === filePath) {
            // Additive batched event (one socket write) for newer clients...
            this.wsHub.broadcast({ type: "conversation_events", sessionId, lines });
            // ...plus per-line conversation_event so older mobile clients,
            // which only know that shape, keep working byte-for-byte.
            for (const line of lines) {
              this.wsHub.broadcast({ type: "conversation_event", sessionId, line });
            }
            break;
          }
        }
      },
      onConversationChanged: (filePath) => {
        // A new JSONL appeared (or changed) in a watched project directory.
        // Invalidate only the affected file's cache row immediately (cheap
        // single-row delete; wiping the whole cache on every event would
        // prevent the warm-up from persisting while active sessions write).
        this.cache?.invalidateByFilePath(filePath);
        // Debounce the global scanner-staleness flip so a burst of directory
        // events during active sessions collapses into one rescan trigger
        // after a quiet period. The debounced callback still checks
        // scannerReady at fire time, preserving the anti-infinite-loop rule
        // (never null scannerReady mid-scan).
        this.markScannerStaleDebounced();
        this.log.debug?.(`Scanner invalidated by directory event: ${filePath}`, {
          filePath,
          event: "cache.directory_change",
        });
      },
      onFileDeleted: (filePath) => {
        const id = this.cache?.invalidateByFilePath(filePath);
        if (id)
          this.log.info(`Cache row invalidated after JSONL delete: ${id}`, {
            id,
            filePath,
            event: "cache.invalidate_on_unlink",
          });
      },
    });

    this.ptyManager = new PTYManager({
      logger: getLogger("pty"),
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
        // Refresh the scanner index at the end of each Claude turn so the
        // conversation is searchable with up-to-date content immediately.
        if (session.status === "waiting_input" || session.status === "idle") {
          const filePath = this.sessionFileMap.get(session.id);
          if (filePath) {
            this.getScanner()
              .then((scanner) => scanner.refreshFile(filePath))
              .then((meta) => {
                this.log.info("scanner.refreshFile: ok", {
                  event: "scanner.refresh",
                  sessionId: session.id,
                  filePath,
                  trigger: session.status,
                  messageCount: meta?.messageCount,
                });
              })
              .catch((err) => {
                this.log.warn("scanner.refreshFile: failed", {
                  event: "scanner.refresh_failed",
                  sessionId: session.id,
                  filePath,
                  trigger: session.status,
                  err,
                });
              });
          }
        }
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

    // ─── Multi-agent mode bootstrap ──────────────────────────────────
    // When MULTI_AGENT_FLOW is on, construct the Temporal client + JSONL
    // writer. We use Connection.lazy() so the constructor stays sync —
    // the actual gRPC connection happens on first RPC.
    this.agentConfig = readAgentConfig();
    const agentConfig = this.agentConfig;
    let conversationWriter: ConversationWriter | null = null;
    if (agentConfig.enabled) {
      const connection = Connection.lazy({
        address: agentConfig.temporal.address,
      });
      const temporalClient = new TemporalClient({
        connection,
        namespace: agentConfig.temporal.namespace,
      });
      this.agentClient = createAgentClient({
        temporalClient,
        taskQueue: agentConfig.temporal.taskQueue,
      });
      // JSONL goes next to (not inside) the SQLite cacheDir, mirroring the
      // existing convention: ~/.threadbase/conversations/.
      const conversationsBaseDir =
        agentConfig.conversationsDir || join(dirname(this.cacheDir), "conversations");
      conversationWriter = createConversationWriter({
        baseDir: conversationsBaseDir,
      });
    }
    const agentClient = this.agentClient;

    const apiDeps: ApiDeps = {
      apiKey: this.apiKey,
      localNoAuth: this.localNoAuth,
      publicUrl: this.publicUrl,
      browseRoot: this.browseRoot,
      ptyManager: this.ptyManager,
      sessionStore: this.sessionStore,
      wsHub: this.wsHub,
      cache: () => this.cache,
      projectsRepo: () => this.projectsRepo,
      conversationsRepo: () => this.conversationsRepo,
      sessionsRepo: () => this.sessionsRepo,
      cacheMetadataRepo: () => this.cacheMetadataRepo,
      ptyAttachedIds: () => this.ptyAttachedIds(),
      handleListSessions: (url, res) => this.handleListSessions(url, res),
      handleSessionsCount: (res) => this.handleSessionsCount(res),
      handleGetRecentSessions: (url, res) => this.handleGetRecentSessions(url, res),
      handleGetSessionNames: (res) => this.handleGetSessionNames(res),
      handleGetSession: (id, res) => this.handleGetSession(id, res),
      handleGetOutput: (id, res) => this.handleGetOutput(id, res),
      handleSendInput: (id, req, res) => this.handleSendInput(id, req, res),
      handleCancel: (id, res) => this.handleCancel(id, res),
      handleSetSessionName: (id, req, res) => this.handleSetSessionName(id, req, res),
      handleUploadFile: (id, req, res) => this.handleUploadFile(id, req, res),
      handleAdopt: (id, res) => this.handleAdopt(id, res),
      handleResume: (req, res) => this.handleResume(req, res),
      handleStartSession: (req, res) => this.handleStartSession(req, res),
      handleListConversations: (url, res) => this.handleListConversations(url, res),
      handleConversationsCount: (url, res) => this.handleConversationsCount(url, res),
      handleGetConversation: (id, url, res, ifNoneMatch) =>
        this.handleGetConversation(id, url, res, ifNoneMatch),
      handleSearch: (url, res) => this.handleSearch(url, res),
      handleGetPopularProjects: (url, res) => this.handleGetPopularProjects(url, res),
      handleListProjectChats: (url, res) => this.handleListProjectChats(url, res),
      handlePairStart: (res) => this.handlePairStart(res),
      handlePairExchange: (req, res) => this.handlePairExchange(req, res),
      handleBrowse: (url, res) => this.handleBrowse(url, res),
      handleMkdir: (req, res) => this.handleMkdir(req, res),
      handleWsOpen: (ws) => {
        this.wsHub.addClient(ws);
        const sessions = this.sessionStore.list(this.ptyAttachedIds());
        ws.send(JSON.stringify({ type: "session_list", sessions }));
        if (this.cacheReady) {
          ws.send(JSON.stringify({ type: "cache_ready" }));
        }
      },
      handleWsMessage: async (ws, raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "register" && typeof msg.clientId === "string") {
            const oldClientId = this.wsToClientId.get(ws);
            if (oldClientId) this.clientIdToWs.delete(oldClientId);
            this.clientIdToWs.set(msg.clientId, ws);
            this.wsToClientId.set(ws, msg.clientId);
          }
          if (msg.type === "subscribe_session" && typeof msg.sessionId === "string") {
            this.addSessionSubscriber(msg.sessionId, ws);
            if (this.ptyManager.hasSession(msg.sessionId)) {
              const lines = await this.ptyManager.getOutputLines(msg.sessionId, 200);
              ws.send(JSON.stringify({ type: "terminal_replay", sessionId: msg.sessionId, lines }));
            }
          }
          if (msg.type === "hold_session" && typeof msg.sessionId === "string") {
            this.startGraceTimer(msg.sessionId, 0);
          }
        } catch {
          // malformed JSON, ignore
        }
      },
      handleWsClose: (ws) => {
        const clientId = this.wsToClientId.get(ws);
        if (clientId) {
          this.clientIdToWs.delete(clientId);
          this.wsToClientId.delete(ws);
        }
        for (const [sessionId, subscribers] of this.sessionSubscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            this.startGraceTimer(sessionId, this.ptyGracePeriodMs);
          }
        }
      },
      agentClient,
      conversationWriter,
      agentConfig,
    };

    this.httpServer = createServer((req, res) => this.handleRequest(req, res));

    // Defense-in-depth against unhandled socket errors that would otherwise
    // crash the process with "Unhandled 'error' event":
    //
    // 1. 'clientError' fires when the http parser rejects a request (bad
    //    headers, etc.). Default behavior destroys the socket, but a stale
    //    handler could leak. We respond 400 (or destroy on any I/O error)
    //    and never throw.
    this.httpServer.on("clientError", (_err, socket) => {
      try {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      } catch {
        socket.destroy();
      }
    });
    // 2. Listener-level 'error' (port in use, etc.) — log instead of crashing.
    this.httpServer.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      // While bindWithRetry is retrying, each failed listen() attempt also
      // reaches this persistent handler. That EADDRINUSE is the expected,
      // self-healing kickstart race — log it at debug, not warn, so boots stay
      // quiet. Genuine runtime errors (and the final give-up) still warn.
      if (this.binding && e.code === "EADDRINUSE") {
        this.log.debug?.(`httpServer error during bind: ${err.message}`, {
          error: err.message,
          event: "http.server_error",
        });
        return;
      }
      this.log.warn(`httpServer error: ${err.message}`, {
        error: err.message,
        event: "http.server_error",
      });
    });
    // 3. The WebSocket upgrade race that caused real prod crashes:
    //    @hono/node-ws registers an 'upgrade' listener that does `await
    //    app.request(...)` before promoting the socket. If the peer RSTs
    //    during the await, the raw net.Socket emits 'error' with no listener,
    //    crashing the process. Registering our own 'upgrade' listener FIRST
    //    attaches a noop 'error' handler to the raw socket so the upgrade
    //    abort becomes a harmless event. Node fires upgrade listeners in
    //    registration order, so this must be wired before injectWebSocket().
    this.httpServer.on("upgrade", (_req, socket) => {
      socket.on("error", () => {
        // Intentional: a RST during the WS handshake is normal client
        // behavior (network blip, peer kill). The socket is already torn
        // down; we just need to absorb the event so Node doesn't crash.
      });
    });

    // createNodeWebSocket needs the real Hono app (it calls app.request() on
    // upgrade). Resolve the chicken-and-egg by creating the app without WS
    // routes first, handing it to createNodeWebSocket, then mounting the WS
    // route onto the same app instance.
    this.honoApp = createHonoApp(apiDeps);
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: this.honoApp });
    this.honoApp.route("/", createWsRoutes(apiDeps, upgradeWebSocket));
    injectWebSocket(this.httpServer);
  }

  // ─── PTY Grace Timer ────────────────────────────────────────────

  private ptyAttachedIds(): Set<string> {
    return new Set(this.ptyManager.listSessions().map((s) => s.id));
  }

  /**
   * Send a session_list to only the client that triggered this HTTP request
   * (identified by X-Client-Id header → registered WS socket). Falls back to
   * a full broadcast if no match exists (old clients, or no WS registered yet).
   */
  private broadcastOrUnicastSessionList(req: IncomingMessage): void {
    const clientId = req.headers["x-client-id"];
    const ws = typeof clientId === "string" ? this.clientIdToWs.get(clientId) : undefined;
    const payload = {
      type: "session_list" as const,
      sessions: this.sessionStore.list(this.ptyAttachedIds()),
    };
    if (ws) {
      this.wsHub.unicast(ws, payload);
    } else {
      this.wsHub.broadcast(payload);
    }
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

  get port(): number {
    const addr = this.httpServer.address();
    return typeof addr === "object" && addr ? addr.port : 0;
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

    // Bind with bounded retry. `launchctl kickstart -k` kills the old prod
    // instance and relaunches immediately; even after the old process has
    // exited cleanly, the kernel can hold :PORT in a transient teardown state
    // for a beat, so the fresh instance's first bind can race into EADDRINUSE.
    // Retrying with a short backoff absorbs that window instead of leaving the
    // process listener-less (the old behavior: the listener-level 'error'
    // handler logged EADDRINUSE once and gave up, failing the deploy
    // healthcheck). On the final attempt we let the error propagate so a
    // genuinely occupied port still surfaces loudly.
    await this.bindWithRetry(port);

    const warmUp = new Promise<void>((resolveWarm) => {
      {
        this.log.info(`Streamer server listening on port ${port}`, {
          port,
          event: "server.listening",
        });
        try {
          this.cache = ConversationCache.open(
            join(this.cacheDir, "cache.db"),
            this.tailSize,
            undefined,
            {
              filterAgentConversations: !this.includeAgents,
              agentEntrypoints: this.agentEntrypoints,
              onAgentFileDetected: (fp) => this.fileWatcher.unwatch(fp),
            },
          );
          if (!this.includeAgents) {
            const result = pruneAgentConversations(this.cache);
            if (result.pruned > 0 || result.missing > 0) {
              this.log.info(
                `Agent conversation prune: scanned=${result.scanned} pruned=${result.pruned} missing=${result.missing}`,
                { ...result, event: "cache.prune_agents" },
              );
            }
          }
          const db = this.cache.getDatabase();
          this.projectsRepo = new ProjectsRepository(db);
          this.conversationsRepo = new ConversationsRepository(this.cache);
          this.sessionsRepo = new SessionsRepository(this.sessionStore);
          this.cacheMetadataRepo = new CacheMetadataRepository(db);
          // Watch ~/.claude/projects so new JSONL files created after startup
          // (e.g. resumed sessions, new conversations from other devices) are
          // discovered: onConversationChanged will invalidate the scanner and
          // cache so the next search/list picks them up without a restart.
          const projectsDir = join(homedir(), ".claude", "projects");
          this.fileWatcher.watchDirectory(projectsDir);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(`ConversationCache failed to open (running without cache): ${message}`, {
            error: message,
            event: "cache.open_failed",
          });
        }
        // Use a dedicated scanner for warm-up, independent of this.scanner, so
        // that onConversationChanged invalidations during the scan cannot cause
        // getScanner() to restart indefinitely and leave the warm-up stuck.
        const warmupScanner = new ConversationScanner();
        const warmupStatCache = this.buildStatCache(null);
        // Throttle the per-file onProgress firings to ~one frame per whole
        // percent (plus the final tick) so a large scan doesn't flood every
        // WebSocket client with thousands of scan_progress messages.
        const shouldEmitProgress = createScanProgressThrottle();
        warmupScanner
          .scan({
            ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
            ...(warmupStatCache ? { statCache: warmupStatCache } : {}),
            onProgress: (scanned, total) => {
              if (shouldEmitProgress(scanned, total)) {
                this.wsHub.broadcast({ type: "scan_progress", scanned, total });
              }
            },
          })
          .then(async () => {
            if (!this.cache) return;
            const metas = [...warmupScanner.getMetadataCache().values()] as any[];
            // upsertFromScannerMeta returns IDs of rows actually upserted
            // (excluding agent JSONLs skipped when includeAgents=false).
            // Warming tails for filtered-out IDs would hit the
            // conversation_tail.conversation_id → conversation_meta(id) FK
            // and abort the whole warm-up before pruneGhostFiles can run.
            const upsertedIds = new Set(this.cache.upsertFromScannerMeta(metas));
            const tailTargets: Array<{ id: string; filePath: string }> = [];
            for (const m of metas) {
              if (!m.filePath) continue;
              const id =
                m.sessionId ||
                m.id
                  ?.split("/")
                  .pop()
                  ?.replace(/\.jsonl$/, "") ||
                m.id;
              if (upsertedIds.has(id)) tailTargets.push({ id, filePath: m.filePath });
            }
            const BATCH = 50;
            let tailFailures = 0;
            for (let i = 0; i < tailTargets.length; i += BATCH) {
              const batch = tailTargets.slice(i, i + BATCH);
              for (const t of batch) {
                try {
                  this.cache.populateTailFromFile(t.id, t.filePath);
                } catch (err) {
                  // Benign race: the live ConversationWatcher runs during
                  // warm-up, so an active session writing/deleting its JSONL
                  // fires invalidateByFilePath() → invalidate(id), which deletes
                  // the conversation_meta row we just upserted. The follow-up
                  // tail insert then trips the conversation_tail → conversation_meta
                  // FK. Skipping is correct — the row was invalidated and gets
                  // re-upserted on the next scan, and pruneGhostFiles (below)
                  // reconciles any file that was genuinely deleted. We must not
                  // throw here or pruneGhostFiles never runs. Logged at info (not
                  // debug) so the failing id+reason is visible by default.
                  tailFailures += 1;
                  this.log.info(
                    `populateTailFromFile skipped for ${t.id}: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                    { id: t.id, event: "cache.warmup_tail_failed" },
                  );
                }
              }
              await new Promise<void>((r) => setImmediate(r));
            }
            if (tailFailures > 0) {
              this.log.warn(
                `Warm-up: ${tailFailures}/${tailTargets.length} tail populates skipped (see info logs for ids)`,
                {
                  failures: tailFailures,
                  total: tailTargets.length,
                  event: "cache.warmup_tail_failures",
                },
              );
            }
            const pruned = this.cache.pruneGhostFiles();
            this.log.info(`Startup ghost prune: removed ${pruned.length} stale cache rows`, {
              count: pruned.length,
              event: "cache.prune_ghosts",
            });
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`Startup cache warm-up failed: ${message}`, {
              error: message,
              event: "cache.warmup_failed",
            });
          })
          .finally(() => {
            // Adopt the warm-up scan as the live scanner so the first real
            // request reuses it instead of paying for a second full scan.
            // Guard: only adopt if nothing else already owns the slot — a
            // request-path getScanner() that built its own scanner during
            // warm-up, or an onConversationChanged that nulled both fields.
            // If invalidation fires after we adopt, the next request rescans
            // (pre-existing fallback); the per-request refreshFile path
            // reconciles single-file drift.
            if (!this.scannerReady && !this.scanner) {
              this.scanner = warmupScanner;
              this.scannerReady = Promise.resolve();
            }
            this.cacheReady = true;
            this.wsHub.broadcast({ type: "cache_ready" });
            resolveWarm();
          });
      }
    });
    if (opts?.awaitReady) await warmUp;
  }

  // Bind the HTTP listener, retrying on a transient EADDRINUSE. See the call
  // site in listen() for why the race exists (kickstart -k relaunch). Total
  // worst case ≈ 6 × 500 ms = 3 s before the final attempt rethrows.
  private async bindWithRetry(port: number, attempts = 6, delayMs = 500): Promise<void> {
    this.binding = true;
    try {
      await this.bindWithRetryLoop(port, attempts, delayMs);
    } finally {
      this.binding = false;
    }
  }

  private async bindWithRetryLoop(port: number, attempts: number, delayMs: number): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException) => {
            this.httpServer.removeListener("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            this.httpServer.removeListener("error", onError);
            resolve();
          };
          this.httpServer.once("error", onError);
          this.httpServer.once("listening", onListening);
          this.httpServer.listen(port);
        });
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EADDRINUSE" && attempt === attempts) {
          // Final attempt exhausted on a still-busy port: this is a genuine
          // failure (not the self-healing kickstart race), so surface it once
          // before rethrowing.
          this.log.error(
            `port ${port} still busy (EADDRINUSE) after ${attempts} attempts; giving up`,
            { port, attempts, event: "server.bind_failed" },
          );
        }
        if (e.code !== "EADDRINUSE" || attempt === attempts) throw err;
        // Routine kickstart-relaunch race: log at debug (invisible by default)
        // since bindWithRetry recovers on its own within the attempt budget.
        this.log.debug?.(
          `port ${port} busy (EADDRINUSE), retry ${attempt}/${attempts - 1} in ${delayMs}ms`,
          { port, attempt, event: "server.bind_retry" },
        );
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
  }

  async close(): Promise<void> {
    for (const timer of this.ptyGraceTimers.values()) clearTimeout(timer);
    this.ptyGraceTimers.clear();
    this.markScannerStaleDebounced.cancel();
    this.cache?.close();
    this.ptyManager.dispose();
    this.fileWatcher.dispose();
    this.wsHub.dispose();
    this.pairTokens.dispose();
    if (this.dbPool) {
      await this.dbPool.end();
    }
    // Force any sockets that survived wsHub.dispose() (e.g. a half-open
    // connection mid-upgrade) to close, so httpServer.close()'s callback —
    // which only fires once every connection drains — can't hang. Without
    // this the old process keeps :PORT bound until launchd's SIGKILL, and the
    // freshly-started instance hits EADDRINUSE. Guarded for Node < 18.2.
    this.httpServer.closeAllConnections?.();
    return new Promise((resolve) => {
      // Belt-and-suspenders: never let process exit block forever on the
      // listener close. The port is released the moment closeAllConnections()
      // runs; the timeout only guards against an unforeseen lingering socket.
      const timer = setTimeout(resolve, 2000);
      this.httpServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ─── Request Router ────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "localhost";
    const webReq = new Request(`http://${host}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers: req.headers as Record<string, string>,
    });
    const honoRes = await this.honoApp.fetch(webReq, { incoming: req, outgoing: res });
    if (honoRes.status !== ALREADY_HANDLED) {
      await writeHonoResponse(honoRes, res);
    }
  }

  // ─── Handlers ──────────────────────────────────────────────────

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
        title: deriveProjectChatTitle({
          title: c.title,
          projectName: c.projectName,
          projectPath: c.projectPath,
          id: c.id,
        }),
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

    const adapted = (page.items as ConversationMeta[]).map((c) => {
      const id =
        c.sessionId ||
        c.id
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "") ||
        c.id;
      return {
        id,
        title: deriveProjectChatTitle({
          title: c.sessionName,
          projectName: c.projectName,
          projectPath: c.projectPath,
          id,
        }),
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
      };
    });
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
    if (!this.cache) {
      json(res, 200, { sessions: [], total: 0 });
      return;
    }
    const { conversations } = this.cache.listConversations({ limit, offset: 0 });
    // Items here are conversation cache rows, not live sessions in SessionStore.
    // The `type` discriminator lets mobile route taps through /api/sessions/resume
    // (which spawns a fresh PTY) instead of GET /api/sessions/:id (which 404s).
    const sessions = conversations.map((c) => ({
      type: "conversation" as const,
      id: c.id,
      status: "idle" as const,
      ptyAttached: false,
      projectId: c.projectId ?? undefined,
      projectPath: c.projectPath ?? "",
      projectName: c.projectName ?? "",
      branch: c.branch ?? undefined,
      lastOutput: "",
      elapsedMs: 0,
      promptCount: c.messageCount,
      startedAt: c.lastActivity,
      lastActivityAt: c.lastActivity,
    }));
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

  private async handleListProjectChats(url: URL, res: ServerResponse): Promise<void> {
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

    await handleListProjectChats(url, res, {
      cache: this.cache,
      projectsRepo: this.projectsRepo,
      conversationsRepo: this.conversationsRepo,
      sessionsRepo: this.sessionsRepo,
      cacheMetadataRepo: this.cacheMetadataRepo,
      getSessionResponses: () => this.sessionStore.list(this.ptyAttachedIds()),
      getFreshScanner: () => this.getFreshScanner(),
    });
  }

  private buildStatCache(
    previousScanner: ConversationScanner | null,
  ): Map<string, { stat: FileStatEntry; meta: ConversationMeta }> | undefined {
    if (!this.cache) return undefined;
    const dbStats = this.cache.getFileStats();
    if (dbStats.size === 0) return undefined;
    const metaByPath = new Map<string, ConversationMeta>();
    if (previousScanner) {
      for (const meta of previousScanner.getMetadataCache().values()) {
        if (meta.filePath) metaByPath.set(meta.filePath, meta);
      }
    }
    const statCache = new Map<string, { stat: FileStatEntry; meta: ConversationMeta }>();
    for (const [filePath, stat] of dbStats) {
      const meta = metaByPath.get(filePath);
      if (meta) statCache.set(filePath, { stat, meta });
    }
    return statCache.size > 0 ? statCache : undefined;
  }

  // skipStaleRescan: when an indexed scanner already exists, return it directly
  // even if scannerStale is set, leaving the flag untouched so the next
  // list-level call still rescans. The single-conversation detail path passes
  // this — its per-file refreshFile (in findConversationByUuid) already
  // reconciles the one conversation being requested, so paying a full-tree
  // rescan just because some OTHER file changed is the stall this avoids.
  private async getScanner(skipStaleRescan = false): Promise<ConversationScanner> {
    if (this.scannerReady) {
      await this.scannerReady;
      // onConversationChanged may have nulled this.scanner while we awaited —
      // if so, fall through and create a fresh one.
      if (this.scanner) {
        if (skipStaleRescan) return this.scanner;
        // If file events arrived while the scan was running, do one rescan now
        // rather than serving a stale result. The stale flag is cleared first so
        // any events during the rescan trigger another pass on the next call.
        if (this.scannerStale) {
          this.scannerStale = false;
          this.scanner = null;
          this.scannerReady = null;
          return this.getScanner();
        }
        return this.scanner;
      }
    }
    this.scannerStale = false;
    const statCache = this.buildStatCache(this.scanner);
    this.scanner = new ConversationScanner();
    this.scannerReady = this.scanner.scan({
      ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
      ...(statCache ? { statCache } : {}),
    });
    await this.scannerReady;
    // Capture before returning — onConversationChanged could null this.scanner
    // in the microtask between the await and the return.
    const scanner = this.scanner;
    if (!scanner) return this.getScanner();
    return scanner;
  }

  private async getFreshScanner(): Promise<ConversationScanner> {
    this.scanner = null;
    this.scannerReady = null;
    return this.getScanner();
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

  private async readCwdFromJsonl(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      let found = false;
      rl.on("line", (line) => {
        if (found) return;
        try {
          const entry = JSON.parse(line);
          if (entry.cwd) {
            found = true;
            rl.close();
            resolve(entry.cwd as string);
          }
        } catch {
          // skip malformed lines
        }
      });
      rl.on("close", () => {
        if (!found) resolve(null);
      });
      rl.on("error", () => resolve(null));
    });
  }

  private async findConversationByUuid(uuid: string): Promise<Conversation | null> {
    // Cold-start fast path: until the warm-up scan has populated this.scanner
    // (this.scannerReady is null), do NOT trigger a full scan to answer a
    // single-conversation request — that scan walks every JSONL on disk and is
    // the 20s+ stall that makes mobile abort. Resolve the file directly
    // (findJsonlPath is an O(project-dirs) walk) and parse just that one file.
    // The warm-up scan keeps running in the background; once it adopts the
    // scanner, subsequent requests use the indexed hot path below.
    if (!this.scannerReady && !this.scanProfiles) {
      const filePath = this.findJsonlPath(uuid);
      if (filePath) {
        const account = this.cache?.getMetaById(uuid)?.account ?? undefined;
        const coldScanner = this.scanner ?? new ConversationScanner();
        const page = await coldScanner.parseSingleFilePage(filePath, account, {
          limit: Number.MAX_SAFE_INTEGER,
        });
        if (page) return page.conversation;
      }
      // No JSONL on disk (or unparseable). Return null WITHOUT triggering a
      // full scan — confirming not-found is not worth the 20s stall. The
      // caller's cache-tail fallback / 404 self-heal handles it.
      return null;
    }

    // Use the existing indexed scanner without honoring the global scannerStale
    // full-rescan: the per-file refreshFile below reconciles the one
    // conversation we care about, so a sibling file changing must not stall this
    // single-conversation request behind a full-tree rescan.
    const scanner = await this.getScanner(true);
    const fromIndex = await scanner.getConversation(uuid);
    if (fromIndex) {
      // The scanner memoizes both its metadata index and parsed conversations
      // for the server's lifetime. A conversation that grows after the initial
      // scan (the chokidar watcher keeps the SQLite cache fresh, but never the
      // scanner) keeps serving the startup snapshot here — so the detail/info
      // view shows a stale message count + last activity that disagrees with
      // the list view and with what --resume actually replays. If the JSONL on
      // disk is newer than the snapshot, refresh just that one file's indexes
      // (refreshFile evicts the stale parse and re-parses on the next read)
      // rather than dropping and rebuilding the entire scanner.
      if (fromIndex.filePath && this.isConversationSnapshotStale(fromIndex)) {
        const refreshedMeta = await scanner.refreshFile(fromIndex.filePath);
        // refreshFile returns null and drops the entry when the file no longer
        // parses (deleted/emptied). In that case return null so the caller's
        // ghost-prune + cache-tail fallback runs instead of serving the stale
        // snapshot we already know is wrong.
        if (!refreshedMeta) return null;
        return (await scanner.getConversation(uuid)) ?? fromIndex;
      }
      return fromIndex;
    }

    if (this.scanProfiles) return null;

    const filePath = this.findJsonlPath(uuid);
    if (!filePath) return null;
    this.scanner = null;
    this.scannerReady = null;
    const freshScanner = await this.getScanner();
    return freshScanner.getConversation(uuid);
  }

  // True when the JSONL on disk is meaningfully newer than the scanned
  // snapshot's last-activity timestamp — i.e. the file grew after the scan.
  private isConversationSnapshotStale(conv: Conversation): boolean {
    if (!conv.filePath) return false;
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(conv.filePath).mtimeMs;
    } catch {
      // Stat failed (file moved/deleted mid-flight) — don't force a re-scan.
      return false;
    }
    return isScannedSnapshotStale(conv.timestamp, mtimeMs);
  }

  private async handleGetConversation(
    id: string,
    url: URL,
    res: ServerResponse,
    ifNoneMatch?: string,
  ): Promise<void> {
    // Try the scanner first (has full content including tool_use blocks).
    // Fall back to the cache tail only when the scanner can't find the file —
    // e.g. a conversation that existed in a previous run but whose JSONL was deleted.
    const conversation = await this.findConversationByUuid(id);

    if (!conversation && this.cache) {
      // Only `before_index` indicates the client is paginating backward (asking
      // for messages older than a cursor) — `msg_limit` is just page size and is
      // sent on the first page too. The tail fallback should serve any first-page
      // request when the JSONL is missing, regardless of msg_limit.
      const isFirstLoad = !url.searchParams.has("before_index");
      if (isFirstLoad) {
        const tail = this.cache.getConversationTail(id);
        if (tail && tail.messages.length > 0) {
          const cachedMeta = this.cache.getMetaById(id);
          const availability = classifyResumability(cachedMeta?.projectPath);
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
              resumable: availability.resumable,
              ...(availability.unavailable_reason && {
                unavailable_reason: availability.unavailable_reason,
              }),
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
      // Self-heal: the row is a ghost (JSONL gone, no usable tail). Drop it so
      // the next list refresh doesn't keep offering this id to clients.
      this.cache?.invalidate(id);
      json(res, 404, { error: "Conversation not found", code: "not_found" });
      return;
    }

    // Compute the conditional-fetch validator from the RESOLVED conversation —
    // findConversationByUuid has already done its staleness refresh above, so
    // these fields reflect the same state the body would. Computing it from a
    // pre-refresh snapshot would let us hand out a 304 against stale data.
    const etagSource = conversation as unknown as {
      filePath: string;
      messageCount: number;
      timestamp: string;
    };
    const etag = computeConversationEtag({
      filePath: etagSource.filePath,
      messageCount: etagSource.messageCount,
      timestamp: etagSource.timestamp,
    });

    // Only the first page ("is the conversation as a whole still current?")
    // participates in the freshness check. Older pages are immutable history —
    // a back-page request (before_index set) always returns its 200 body, never
    // a 304, even when the client echoes a matching If-None-Match.
    const isFirstPage = !url.searchParams.has("before_index");
    if (isFirstPage && ifNoneMatch && ifNoneMatch === etag) {
      // This is a direct-`ServerResponse` write, so the Hono CORS middleware's
      // headers don't reach it — set the expose header here so a cross-origin
      // client can read the validator off the 304 too.
      res.writeHead(304, { ETag: etag, "Access-Control-Expose-Headers": "ETag" });
      res.end();
      return;
    }

    const filtered = conversation.messages;
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
      // Only consult the scanner's paged reader when it's already warm. On the
      // cold path `conversation` came from the single-file fast path and holds
      // every message in memory, so slice it locally — calling getScanner()
      // here would trigger the full scan the fast path exists to avoid. Pass
      // skipStaleRescan: this is the same single-conversation detail path, whose
      // refreshFile already reconciled the one file we page here, so a sibling
      // file's stale flag must not stall this read behind a full-tree rescan.
      const pagedScanner = this.scannerReady
        ? ((await this.getScanner(true)) as unknown as {
            getConversationPage?: (
              id: string,
              options: { beforeIndex: number; limit: number },
            ) => Promise<{ messages: typeof filtered; total: number; fromIndex: number } | null>;
          })
        : null;
      const page =
        pagedScanner && typeof pagedScanner.getConversationPage === "function"
          ? await pagedScanner.getConversationPage(id, { beforeIndex, limit })
          : null;
      const start = page?.fromIndex ?? Math.max(0, beforeIndex - limit);
      slice = page?.messages ?? filtered.slice(start, beforeIndex);
      fromIdx = start;
      messagePagination = {
        total: page?.total ?? total,
        before_index: beforeIndex,
        from_index: start,
        has_more_older: start > 0,
        next_before_index: start > 0 ? start : null,
      };
    }

    const messagesPayload = slice.map((m: any, localIdx: number) => {
      const content: unknown[] = [];
      if (m.isThinking) {
        content.push({
          type: "thinking",
          thinking: m.thinkingContent ?? "",
          signature: m.thinkingSignature,
        });
      }
      for (const b of m.metadata?.toolUseBlocks ?? []) {
        content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      for (const r of m.metadata?.toolResults ?? []) {
        content.push({
          type: "tool_result",
          tool_use_id: r.toolUseId,
          content: JSON.stringify(r.content),
          is_error: r.isError ?? false,
        });
      }
      return {
        uuid: m.uuid ?? null,
        message_index: fromIdx + localIdx,
        role: m.role,
        timestamp: m.timestamp,
        text: m.text,
        tool_calls: m.metadata?.toolUses ?? [],
        has_images: m.hasImages ?? false,
        parent_uuid: m.parentUuid ?? null,
        permission_mode: m.permissionMode ?? null,
        is_sidechain: m.isSidechain ?? false,
        is_tool_result: m.isToolResult ?? false,
        attachment: m.attachment ?? null,
        content,
      };
    });

    const conv = conversation as any;
    const availability = classifyResumability(conv.projectPath);
    const body: Record<string, unknown> = {
      meta: {
        id,
        profile_id: conv.account,
        project_name: conv.projectName,
        project_path: conv.projectPath,
        file_path: conv.filePath,
        last_updated_at: conv.timestamp,
        message_count: conv.messageCount,
        last_prompt: conv.lastPrompt ?? undefined,
        resumable: availability.resumable,
        ...(availability.unavailable_reason && {
          unavailable_reason: availability.unavailable_reason,
        }),
      },
      messages: messagesPayload,
    };
    if (messagePagination) body.message_pagination = messagePagination;
    if (conv.turnDurations?.length) {
      body.turn_durations = conv.turnDurations.map((d: any) => ({
        duration_ms: d.durationMs,
        message_count: d.messageCount,
        uuid: d.uuid,
      }));
    }
    // Always expose the ETag on the 200 so the client can store it and send it
    // back as If-None-Match next time. Old clients ignore the header. This is a
    // direct-`ServerResponse` write that bypasses the Hono CORS middleware, so
    // the expose header is set here too — without it a cross-origin client
    // can't read ETag.
    res.writeHead(200, {
      "Content-Type": "application/json",
      ETag: etag,
      "Access-Control-Expose-Headers": "ETag",
    });
    res.end(JSON.stringify(body));
  }

  private async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams.get("q") ?? "";
    if (!q) {
      json(res, 400, { error: "Missing query parameter: q" });
      return;
    }

    const limit = intParam(url, "limit", 50);
    const scanner = await this.getScanner();
    const results = await search(
      q,
      {
        limit,
        include: "conversations",
        ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
      },
      scanner,
    );
    const adapted = results.map((r: any) => ({
      id:
        r.meta.id
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "") || r.meta.id,
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
    if (session) {
      if (!existsSync(session.projectPath)) {
        session.failureReason = `Project directory not found: ${session.projectPath}`;
      }
      json(res, 200, session);
      return;
    }
    // Fall back to the conversation cache: older mobile builds tap recents
    // entries via GET /api/sessions/:id even though those IDs are conversation
    // UUIDs, not live sessions. Returning a resumable shape (status=on_hold)
    // lets the mobile open flow proceed to /api/sessions/resume.
    const conversation = this.cache?.getMetaById(sessionId);
    if (conversation) {
      json(res, 200, conversationToResumableSession(conversation));
      return;
    }
    json(res, 404, { error: "Session not found" });
  }

  private async handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.discoveryCache = null;
    const body = await readBody(req);
    // Accept both sessionId (new) and conversationId (legacy alias)
    const sessionId: string | undefined = body.sessionId ?? body.conversationId;

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

    // Authoritative cwd comes from the JSONL itself — the file Claude looks
    // up by filename when processing --resume. The scanner index can return a
    // stale or wrong path (e.g. …/tb-mobile/android vs …/tb-mobile), so we
    // read the first cwd field directly, mirroring tb-scanner/src/parser.ts.
    const jsonlPath = this.findJsonlPath(sessionId);
    const jsonlCwd = jsonlPath ? await this.readCwdFromJsonl(jsonlPath) : null;

    const conv = await this.findConversationByUuid(sessionId);
    const projectPath: string = jsonlCwd ?? (conv as any)?.projectPath;
    if (!projectPath) {
      if (!conv && !jsonlPath) {
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

    this.sessionStore.addManaged(session);

    // Watch the conversation's JSONL file for structured events
    void this.watchConversationFile(sessionId);

    const resp = this.sessionStore.get(session.id, this.ptyAttachedIds());
    this.broadcastOrUnicastSessionList(req);

    json(res, 201, resp ?? session);

    // Enrich session metadata and update DB in background (fire-and-forget).
    // The conversation history is already in the JSONL; DB writes are
    // bookkeeping that can happen asynchronously without blocking the response.
    this.enrichResumedSessionAsync(sessionId, projectPath, conv);
  }

  private enrichResumedSessionAsync(sessionId: string, projectPath: string, conv: any): void {
    try {
      const session = this.sessionStore.get(sessionId, this.ptyAttachedIds());
      if (!session) return;

      if (conv) {
        session.sessionName = conv.sessionName ?? undefined;
        session.messageCount = conv.messageCount ?? 0;
        session.account = conv.account ?? undefined;
        session.filePath = conv.filePath ?? undefined;
      }

      if (!this.cache || !this.projectsRepo || !this.conversationsRepo) return;

      // Single SQLite read covers model, preview, timestamps, and projectId —
      // no scanner round-trip needed; these fields are already cached.
      const cached = this.cache.getMetaById(sessionId);
      if (cached) {
        session.model = cached.model ?? undefined;
        session.preview = cached.preview ?? undefined;
        const first = cached.firstMessage ? JSON.parse(cached.firstMessage as string) : null;
        const last = cached.lastMessage ? JSON.parse(cached.lastMessage as string) : null;
        session.firstMessageText = first?.text ?? undefined;
        session.firstMessageAt = first?.timestamp
          ? new Date(first.timestamp).toISOString()
          : undefined;
        session.lastMessageText = last?.text ?? undefined;
        session.lastMessageAt = last?.timestamp
          ? new Date(last.timestamp).toISOString()
          : undefined;
      }

      let resolvedProjectId: string | null = cached?.projectId ?? null;
      if (!resolvedProjectId) {
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
    } catch (err) {
      // ponytail: log but don't crash; session is already live and usable
      console.error(`[enrichResumedSessionAsync] ${sessionId}:`, err);
    }
  }

  private async handleSendInput(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (this.agentConfig.enabled) {
      const body = await readBody(req);
      const cache = this.cache;
      if (!cache) {
        json(res, 503, {
          error: "Conversation cache is not available",
          code: "INTERNAL_ERROR",
        });
        return;
      }
      const result = await handleSendAgentInput(sessionId, body, {
        sessionStore: this.sessionStore,
        cache,
        // biome-ignore lint/style/noNonNullAssertion: agentClient is set when agentConfig.enabled is true
        agentClient: this.agentClient!,
        agentConfig: this.agentConfig,
      });
      json(res, result.status, result.body);
      return;
    }
    const body = await readBody(req);
    const { input, keys } = body;

    if (typeof keys === "string") {
      // Raw key bytes (e.g. arrow navigation for interactive prompts).
      // These bypass bracketed-paste wrapping — caller is responsible for
      // sending well-formed escape sequences.
      try {
        this.ptyManager.sendKeys(sessionId, keys);
        const updated = this.sessionStore.get(sessionId, this.ptyAttachedIds());
        if (updated) {
          this.wsHub.broadcast({ type: "session_update", session: updated });
        }
        json(res, 200, { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to send keys";
        json(res, 400, { error: message });
      }
      return;
    }

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
      // Index the user's new message immediately so it's searchable right away.
      const filePath = this.sessionFileMap.get(sessionId);
      if (filePath) {
        this.getScanner()
          .then((scanner) => scanner.refreshFile(filePath))
          .then((meta) => {
            this.log.info("scanner.refreshFile: ok", {
              event: "scanner.refresh",
              sessionId,
              filePath,
              trigger: "sendInput",
              messageCount: meta?.messageCount,
            });
          })
          .catch((err) => {
            this.log.warn("scanner.refreshFile: failed", {
              event: "scanner.refresh_failed",
              sessionId,
              filePath,
              trigger: "sendInput",
              err,
            });
          });
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
    if (this.agentConfig.enabled) {
      const body = await readBody(req);
      const result = await handleStartAgentSession(body, {
        sessionStore: this.sessionStore,
        // biome-ignore lint/style/noNonNullAssertion: agentClient is set when agentConfig.enabled is true
        agentClient: this.agentClient!,
        conversationsDir: this.cacheDir ? join(dirname(this.cacheDir), "conversations") : "",
        agentConfig: this.agentConfig,
      });
      json(res, result.status, result.body);
      if (result.status === 200) {
        this.broadcastOrUnicastSessionList(req);
      }
      return;
    }
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

      this.broadcastOrUnicastSessionList(req);
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

      // Primary: Claude named the file after the session UUID
      let resolvedFilePath = existsSync(filePath) ? filePath : null;

      // Fallback: Claude resumed an existing conversation — the JSONL it writes
      // to will be a different UUID. Pick the most recently modified JSONL in
      // the directory that was touched within the last 5 seconds (session just started).
      if (!resolvedFilePath && existsSync(projectsDir)) {
        try {
          const now = Date.now();
          const recent = readdirSync(projectsDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ f, mtime: statSync(join(projectsDir, f)).mtimeMs }))
            .filter(({ mtime }) => now - mtime < 5_000)
            .sort((a, b) => b.mtime - a.mtime)[0];
          if (recent) resolvedFilePath = join(projectsDir, recent.f);
        } catch {
          /* ignore */
        }
      }

      if (!resolvedFilePath) return;

      cleanup();
      this.sessionFileMap.set(sessionId, resolvedFilePath);
      this.fileWatcher.watch(resolvedFilePath);

      // Broadcast any lines already written before the watcher started — Claude
      // can finish writing the JSONL in the same tick as the watcher wires up,
      // so chokidar won't emit a change event for those lines.
      try {
        const existing = readFileSync(resolvedFilePath, "utf8").split("\n").filter(Boolean);
        if (existing.length > 0) {
          this.wsHub.broadcast({ type: "conversation_events", sessionId, lines: existing });
          for (const line of existing) {
            this.wsHub.broadcast({ type: "conversation_event", sessionId, line });
          }
        }
      } catch {
        /* ignore — file may not be readable yet; watcher will catch future writes */
      }

      if (this.scannerReady) {
        this.scannerStale = true;
      } else {
        this.scanner = null;
      }
      this.linkSessionToProject(sessionId, projectPath, resolvedFilePath);
      this.cache?.markAsStreamer(sessionId);
      this.log.info(
        `[startFresh] wired JSONL for ${sessionId}`,
        { event: "session.jsonl_wired", sessionId, filePath: resolvedFilePath },
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
      if (err instanceof BrowsePathNotFoundError) {
        json(res, 404, { error: message, code: "PATH_NOT_FOUND" });
        return;
      }
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

// Classify whether a conversation can be resumed from the project directory
// (cwd) the session ran in. Shared by the detail handler and the
// resumable-session shape. A conversation's JSONL parses fine even when its
// cwd is gone, so callers still serve the full history — this only flags that
// resume would fail and why. Returns optional meta fields older clients
// ignore: cwd exists → resumable; gone → not resumable, with a
// worktree-specific reason when the path was a git worktree (now removed).
function classifyResumability(cwd: string | null | undefined): {
  resumable: boolean;
  unavailable_reason?: "path_missing" | "worktree_removed";
} {
  if (!cwd) return { resumable: true };
  if (existsSync(cwd)) return { resumable: true };
  const ranInWorktree = /\/\.worktrees\//.test(cwd) || /\/\.claude\/worktrees\//.test(cwd);
  return {
    resumable: false,
    unavailable_reason: ranInWorktree ? "worktree_removed" : "path_missing",
  };
}

function conversationToResumableSession(c: ConversationListItem) {
  const availability = classifyResumability(c.projectPath);
  return {
    type: "conversation" as const,
    id: c.id,
    conversationId: c.id,
    status: "on_hold" as const,
    ptyAttached: false,
    projectId: c.projectId ?? undefined,
    projectPath: c.projectPath ?? "",
    projectName: c.projectName ?? "",
    branch: c.branch ?? undefined,
    lastOutput: "",
    elapsedMs: 0,
    promptCount: c.messageCount,
    startedAt: c.lastActivity,
    completedAt: null,
    lastActivityAt: c.lastActivity,
    ...(c.title != null && { sessionName: c.title }),
    ...(c.model != null && { model: c.model }),
    ...(c.account != null && { account: c.account }),
    messageCount: c.messageCount,
    ...(c.preview != null && { preview: c.preview }),
    ...(c.firstMessage != null && { firstMessageText: c.firstMessage }),
    ...(c.lastMessage != null && { lastMessageText: c.lastMessage }),
    filePath: c.filePath,
    resumable: availability.resumable,
    ...(availability.unavailable_reason && {
      unavailable_reason: availability.unavailable_reason,
    }),
  };
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function writeHonoResponse(honoRes: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  honoRes.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(honoRes.status, headers);
  if (honoRes.body) {
    const reader = honoRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}

// Parse THREADBASE_DIR_SCAN_DEBOUNCE_MS → a non-negative integer, or undefined
// when unset/invalid so the caller can fall through to config/default.
function parseDirScanDebounceEnv(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
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
