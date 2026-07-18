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
import { EventEmitter } from "events";
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
  generateApiKey,
  loadBrowseRoot,
  loadBrowserCors,
  loadCacheDir,
  loadDefaultPermissionMode,
  loadPublicUrl,
  loadTailSize,
  setApiKey,
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
import { handleListProjects } from "./handlers/handleListProjects";
import { LiveSessionManager } from "./live-session-manager";
import { getLogger } from "./logger";
import { PairTokenStore } from "./pair-store";
import { discoverClaudeProcesses } from "./process-discovery";
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_CLI_PROVIDER,
  coerceProviderForRunner,
  isProviderName,
  isProviderResumable,
} from "./providers";
import { seal } from "./seal";
import { CacheIntegrityMonitor } from "./services/cache-integrity/cacheIntegrityMonitor";
import { ConversationWatcher } from "./services/conversations/conversationWatcher";
import {
  findSearchTarget,
  type SearchableMessage,
} from "./services/conversations/findSearchTarget";
import { parseAgentEntrypointsEnv } from "./services/conversations/isAgentConversation";
import { pruneAgentConversations } from "./services/conversations/pruneAgentConversations";
import { deriveProjectChatTitle } from "./services/projectChats/deriveProjectChatTitle";
import { questionContentKey } from "./services/questions/detectQuestionFromScreen";
import {
  questionsFromLines,
  shouldBroadcastQuestion,
} from "./services/questions/questionBroadcast";
import { resolveAnswer } from "./services/questions/resolveAnswer";
import { SessionStore } from "./session-store";
import type {
  AskQuestion,
  DiscoveredProcess,
  PermissionOption,
  ServerConfig,
  SessionSortKey,
  SortOrder as SessionSortOrder,
  SessionStatus,
} from "./types";

import { saveUploadFile } from "./uploads";
import { isCodexInjectedContext, toClientConversationLines } from "./utils/codexConversationLine";
import { computeConversationEtag } from "./utils/conversationEtag";
import { debounce } from "./utils/debounce";
import { isScannedSnapshotStale } from "./utils/isScannedSnapshotStale";
import { createScanProgressThrottle } from "./utils/scanProgressThrottle";
import { WSHub } from "./ws-hub";

const BROWSE_SYSTEM_PROMPT = (browseRoot: string) =>
  `You are working within the project boundary: ${browseRoot}. ` +
  `Do not read, write, or execute commands that access files or directories outside this boundary.`;

const DEFAULT_SYSTEM_PROMPT =
  "When presenting options or choices to the user, limit the options to at most 3.";

const DEFAULT_PTY_GRACE_PERIOD_MS = 270_000; // 4.5 minutes

// A completed refreshFile within this window is treated as fresh — a retry
// storm on a live conversation collapses to one parse per window instead of
// one per request.
const REFRESH_TTL_MS = 2000;

// Session start blocks for the PTY to reach waiting_input/idle before
// responding; past this we fall back to the async 202 shape. Must stay BELOW
// the mobile client's start-request fetch timeout (15s) — at the old 15s value
// the client aborted first ("fetch canceled") and its retry double-spawned
// sessions. Ready normally lands well under this: Claude's quiet-checker and
// Codex's CODEX_READY_FALLBACK_MS (8s) both settle pendingReady first.
const START_READY_TIMEOUT_MS = 10_000;

// Default OFF. Set to "1" or "true" to show Claude Agent SDK / claude-mem
// runs in /api/conversations and /project-chats.
export function parseIncludeAgentsEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off" || v === "");
}

export class StreamerServer {
  private httpServer: ReturnType<typeof createServer>;
  private ptyManager: LiveSessionManager;
  private sessionStore: SessionStore;
  private wsHub: WSHub;
  private fileWatcher: ConversationWatcher;
  private sessionFileMap = new Map<string, string>(); // sessionId → JSONL filePath
  // Per-file seq assignments from the most recent onNewLineSpans (offset index),
  // handed to the immediately-following onNewLines so it can stamp WS `seq` on
  // the matching conversation_events entries. Same read → same lines order.
  private pendingLineSeqs = new Map<string, (number | null)[]>();
  private pendingQuestions = new Map<string, { toolUseId: string; questions: AskQuestion[] }>();
  // Content key of the AskUserQuestion currently broadcast for a session (from
  // either the rendered screen or JSONL), used to de-dupe the two paths: when
  // the screen detection fires first, the later JSONL flush of the same question
  // is suppressed. Cleared alongside pendingQuestions.
  private pendingQuestionKey = new Map<string, string>();
  // Per-session permission gate currently open (scraped via OSC 777). Parallel
  // to pendingQuestions; mobile answers it by sending the option index via
  // /input { keys }. Cleared when the gate closes.
  private pendingPermission = new Map<
    string,
    { prompt?: string; detail?: string; options: PermissionOption[]; cursor?: number }
  >();
  private scanner: ConversationScanner | null = null;
  // Set when better-sqlite3 is unusable (e.g. node ABI mismatch made
  // ConversationCache.open throw), or when config.scannerPersistent is false
  // (test isolation — the scanner's default SQLite index is a single shared
  // file unscoped by scanProfiles). All scanners are then built with
  // persistent: false so requests serve from disk instead of 500ing on
  // every touch of the scanner's own SQLite index.
  private scannerPersistenceDisabled = false;
  // Tracks every ConversationScanner ever created so close() can shut them all
  // down and release SQLite handles (open handles block temp-dir deletion on Windows).
  private allScanners = new Set<ConversationScanner>();
  private scannerReady: Promise<unknown> | null = null;
  // Set by onConversationChanged while a scan is in-flight; getScanner() does
  // a single rescan after the current one completes instead of restarting it.
  private scannerStale = false;
  // Single-flight + TTL guard around scanner.refreshFile (see refreshFileGuarded).
  // A live file's mtime is always newer than the snapshot, so an unguarded
  // refresh fires on every request and re-parses the whole file from byte 0.
  // Keyed by filePath; entries drop on settle + TTL expiry, so the map stays
  // bounded by the active-file set.
  private refreshInFlight = new Map<string, { promise: Promise<unknown>; completedAt: number }>();
  // True only while bindWithRetry is actively retrying. The persistent
  // listener-level 'error' handler demotes EADDRINUSE to debug during this
  // window so the self-healing kickstart-relaunch race doesn't spam warn.
  private binding = false;
  private cacheReady = false;
  // Every fire-and-forget task that runs a scan and then writes to this.cache
  // in an async continuation (startup warm-up, background count refresh, …).
  // close() awaits all of them before closing this.cache, so a scan's post-scan
  // cache writes (upsertFromScannerMeta / populateTailFromFile / pruneGhostFiles
  // / reconcileDeletions) can never hit a cache.db that was already closed
  // ("database connection is not open"), which would otherwise leave the cache
  // empty. Register via trackCacheWrite(); each entry removes itself on settle.
  private inFlightCacheWrites = new Set<Promise<unknown>>();
  private apiKey: string;
  private apiKeySource: "config" | "cli";
  private localNoAuth: boolean;
  private logMenubarRequests: boolean;
  private verbose: boolean;
  private scanProfiles:
    | Array<{ id: string; label: string; configDir: string; enabled: boolean; emoji: string }>
    | undefined;
  private dbPool: Awaited<ReturnType<typeof createPool>> | null = null;
  private dbInstanceId: string | null = null;
  private disableDb = false;
  private browseRoot: string | null = null;
  private publicUrl: string | null = null;
  private browserCors: string | undefined;
  private pairTokens = new PairTokenStore();
  private exchangeAttempts = new Map<string, number[]>();
  private sessionStartAttempts = new Map<string, number[]>();
  private sessionInputAttempts = new Map<string, number[]>();
  private ptyGracePeriodMs: number;
  private defaultSystemPrompt: string;
  private defaultPermissionMode: "acceptEdits" | "manual";
  // Map of sessionId → grace timer; fires to kill PTY after WS disconnect
  private ptyGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Map of sessionId → set of subscribed WS clients
  private sessionSubscribers = new Map<string, Set<WebSocket>>();
  // Map of clientId → WS socket (populated by the "register" WS handshake)
  private clientIdToWs = new Map<string, WebSocket>();
  // Reverse map for cleanup on close
  private wsToClientId = new Map<WebSocket, string>();
  private cache: ConversationCache | null = null;
  private cacheMonitor: CacheIntegrityMonitor | null = null;
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
  private codexRoots: string[];
  private includeAgents: boolean;
  private agentEntrypoints: ReadonlySet<string>;
  private honoApp: Hono<AppEnv>;
  private log = getLogger("server");
  private agentConfig: AgentConfig;
  private agentClient: AgentClient | null = null;
  private sessionStatusBus = new EventEmitter();

  constructor(config: ServerConfig & { apiKey: string }) {
    this.sessionStatusBus.setMaxListeners(0);
    this.apiKey = config.apiKey;
    this.apiKeySource = config.apiKeySource ?? "config";
    this.localNoAuth = config.localNoAuth ?? false;
    this.logMenubarRequests = config.logMenubarRequests ?? false;
    if (this.localNoAuth) {
      console.warn(
        "[WARN] localNoAuth is ENABLED — all requests from localhost bypass authentication. " +
          "Do not run with --local-no-auth in shared or production environments.",
      );
    }
    this.verbose = config.verbose ?? false;
    this.disableDb = config.disableDb ?? false;
    this.scannerPersistenceDisabled = config.scannerPersistent === false;
    this.scanProfiles = config.scanProfiles;
    this.codexRoots = config.codexRoots ?? [join(homedir(), ".codex", "sessions")];
    this.ptyGracePeriodMs = config.ptyGracePeriodMs ?? DEFAULT_PTY_GRACE_PERIOD_MS;
    this.defaultSystemPrompt = config.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.defaultPermissionMode =
      config.defaultPermissionMode ?? loadDefaultPermissionMode() ?? "acceptEdits";
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

    this.browserCors = config.browserCors ?? loadBrowserCors();

    this.sessionStore = new SessionStore();
    this.wsHub = new WSHub();

    this.fileWatcher = new ConversationWatcher({
      onNewLineSpans: (filePath, spans, readFrom, endOffset) => {
        // Offset index: extend the per-message byte-span index with this read's
        // lines. Fires alongside onNewLines (which writes the tail); both
        // consume the same read. Best-effort — a failure here must never break
        // the tail write or WS broadcast.
        if (!this.cache) return;
        const cache = this.cache;
        // No stale seqs from a prior read may leak into this one's WS stamping.
        this.pendingLineSeqs.delete(filePath);
        try {
          const seqs = cache.extendMessageIndex(
            filePath,
            spans,
            statSync(filePath),
            readFrom,
            endOffset,
          );
          if (seqs === null) {
            // Non-contiguous read (watcher attached at EOF after downtime, or an
            // append raced a backfill): drop the file's index and rebuild from
            // scratch. Single-flighted, tracked so close() awaits it. No seqs
            // are stamped for this read — the client refetches on reconcile.
            cache.deleteFileIndex(filePath, ConversationCache.conversationIdForFile(filePath));
            cache.clearIndexParseState(filePath);
            this.trackCacheWrite(
              cache.backfillIndex(filePath).catch((err) => {
                this.log.warn("offset-index.backfill_failed", {
                  event: "offset_index.backfill_failed",
                  filePath,
                  trigger: "noncontiguous-append",
                  err,
                });
              }),
            );
            return;
          }
          // Stash for the onNewLines handler (fires next for the same read) to
          // stamp WS `seq`. spans and lines are the same set in the same order.
          this.pendingLineSeqs.set(filePath, seqs);
        } catch (err) {
          this.log.warn("offset-index.extend_failed", {
            event: "offset_index.extend_failed",
            filePath,
            err,
          });
        }
      },
      onNewLines: (filePath, lines) => {
        // One transactional cache write for the whole batch instead of per line.
        this.cache?.updateFromLines(filePath, lines);
        for (const [sessionId, watchedPath] of this.sessionFileMap) {
          if (watchedPath === filePath) {
            // toolUseId the client currently holds for this session (set by the
            // live-screen path as `screen:…`, or a prior JSONL flush). Captured
            // BEFORE the overwrite below so we can detect an id change.
            const priorToolUseId = this.pendingQuestions.get(sessionId)?.toolUseId;
            const { messages, pending } = questionsFromLines(sessionId, lines);
            for (const p of pending) {
              this.pendingQuestions.set(sessionId, p); // last pending wins
              const t = setTimeout(() => {
                if (this.pendingQuestions.get(sessionId)?.toolUseId === p.toolUseId) {
                  this.cancelPendingQuestion(sessionId);
                }
              }, 60_000);
              t.unref();
            }
            // De-dupe vs the live-screen path: if the rendered detection already
            // broadcast this exact question (same content key), don't re-render —
            // EXCEPT when the real JSONL toolUseId differs from the synthetic
            // `screen:` id the client holds. The client answers with the id it
            // was given; if it still has the screen id, resolveAnswer rejects the
            // POST as tool_use_mismatch. Re-broadcasting the real id re-syncs the
            // client (mapAskQuestionToBlock just replaces activeQuestion — the
            // card re-renders identically) so answering works.
            for (const m of messages) {
              const key = questionContentKey(m.questions);
              const broadcast = shouldBroadcastQuestion({
                newContentKey: key,
                lastContentKey: this.pendingQuestionKey.get(sessionId),
                newToolUseId: m.toolUseId,
                priorToolUseId,
              });
              this.pendingQuestionKey.set(sessionId, key);
              if (broadcast) this.wsHub.broadcast(m);
            }
            // Additive batched event (one socket write) for newer clients. When
            // the offset index assigned seqs for this read, carry them parallel
            // to lines so a client can map each event to its message_index.
            // Codex rollout lines are normalized to Claude shape here — mobile
            // parseLineToMessage only understands type:user|assistant.
            const seqs = this.pendingLineSeqs.get(filePath);
            this.broadcastConversationLines(sessionId, lines, seqs);
            break;
          }
        }
        // Seqs are consumed for this read; drop them so a later read for a file
        // with no watched session can't reuse a stale mapping.
        this.pendingLineSeqs.delete(filePath);
      },
      onConversationChanged: (filePath) => {
        // A new JSONL appeared (or changed) in a watched project directory.
        // If we hold a per-file tail for it, re-drive the tail read from here
        // too: per-file fs.watch handles can die silently (2026-07-01 incident
        // — tails went permanently quiet while directory events kept flowing),
        // and the directory watcher is the survivor that can heal them.
        this.fileWatcher.poke(filePath);
        // Invalidate only the affected file's cache row immediately (cheap
        // single-row delete; wiping the whole cache on every event would
        // prevent the warm-up from persisting while active sessions write).
        // skipIfTailed: this same append also drives the live-tail watcher's
        // updateFromLines upsert; the two fire with no ordering guarantee, so
        // never delete a row a live tail just wrote (CRITICAL #2).
        this.cache?.invalidateByFilePath(filePath, { skipIfTailed: true });
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
        // While an alert is pending, freeze: queue the deletion instead of
        // invalidating the row, so an rm -rf mid-freeze can't drain the cache.
        if (this.cacheMonitor?.pending) {
          this.cacheMonitor.deferUnlink(filePath);
          return;
        }
        const id = this.cache?.invalidateByFilePath(filePath);
        if (id)
          this.log.info(`Cache row invalidated after JSONL delete: ${id}`, {
            id,
            filePath,
            event: "cache.invalidate_on_unlink",
          });
        // Feed the storm detector — a burst of unlinks re-triggers detection.
        this.cacheMonitor?.recordUnlink(filePath);
      },
    });

    this.ptyManager = new LiveSessionManager({
      logger: getLogger("pty"),
      onOutput: (sessionId, data) => {
        this.wsHub.broadcast({ type: "terminal_output", sessionId, data });
      },
      onUserMessage: (sessionId, text, ts) => {
        this.wsHub.broadcast({ type: "user_message", sessionId, text, ts });
      },
      onPermissionChange: (sessionId, gate) => {
        this.handlePermissionChange(sessionId, gate);
      },
      onLiveQuestion: (sessionId, questions) => {
        this.handleLiveQuestion(sessionId, questions);
      },
      onLiveQuestionGone: (sessionId) => {
        // The rendered AskUserQuestion menu closed. Clear the screen-dedupe key
        // and cancel the pending question so the answered card is dismissed and
        // a later repaint can't re-broadcast it. Only acts on a screen-scoped
        // question — once the JSONL flush recorded the real toolUseId, the
        // answer path (handleSendAnswer) already cleared it.
        this.pendingQuestionKey.delete(sessionId);
        const pq = this.pendingQuestions.get(sessionId);
        if (pq?.toolUseId.startsWith("screen:")) {
          this.cancelPendingQuestion(sessionId);
        }
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
              .then((scanner) => this.refreshFileGuarded(scanner, filePath))
              .then((meta) => {
                // meta === null means the guard coalesced/skipped this refresh
                // (already in flight or within the TTL) — not a real result.
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
            this.cancelPendingQuestion(session.id);
          }
          // A gone PTY can never have an open gate; clear silently.
          this.pendingPermission.delete(session.id);
        }
        const resp = this.sessionStore.get(session.id, this.ptyAttachedIds());
        if (resp) {
          this.wsHub.broadcast({ type: "session_update", session: resp });
        }
        this.sessionStatusBus.emit(`status:${session.id}`, session.status);
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

    const self = this;
    const apiDeps: ApiDeps = {
      // ponytail: getter so rotateApiKey() takes effect without restarting the server
      get apiKey() {
        return self.apiKey;
      },
      localNoAuth: this.localNoAuth,
      logMenubarRequests: this.logMenubarRequests,
      rotateApiKey: () => this.rotateApiKey(),
      publicUrl: this.publicUrl,
      browseRoot: this.browseRoot,
      browserCors: this.browserCors,
      ptyManager: this.ptyManager,
      sessionStore: this.sessionStore,
      wsHub: this.wsHub,
      cache: () => this.cache,
      cacheMonitor: () => this.cacheMonitor,
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
      handleSendAnswer: (id, req, res) => this.handleSendAnswer(id, req, res),
      handleCancel: (id, res) => this.handleCancel(id, res),
      handleStopSession: (id, res) => this.handleStopSession(id, res),
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
      handleSearchTarget: (id, req, res) => this.handleSearchTarget(id, req, res),
      handleListProjects: (url, res) => handleListProjects(url, res),
      handleGetPopularProjects: (url, res) => this.handleGetPopularProjects(url, res),
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
        // Re-surface a pending cache-integrity alert to every connecting client
        // (covers the pre-cacheReady startup window and every reconnect).
        const alertMsg = this.cacheMonitor?.wsMessage();
        if (alertMsg) this.wsHub.unicast(ws, alertMsg);
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
              const userMessages = this.ptyManager.getInputHistory(msg.sessionId);
              ws.send(
                JSON.stringify({
                  type: "terminal_replay",
                  sessionId: msg.sessionId,
                  lines,
                  userMessages,
                }),
              );
            }
            // A gate/question can open before the client finishes subscribing
            // (Codex's startup gates fire within ~500ms of spawn) — broadcast()
            // only reaches already-subscribed sockets, so a card that opened in
            // that window is otherwise lost forever. Replay pending state the
            // same way terminal_replay does above.
            const pendingGate = this.pendingPermission.get(msg.sessionId);
            if (pendingGate) {
              this.log.info(`[ws.replay_permission] ${msg.sessionId.slice(0, 8)}`, {
                event: "ws.replay_permission",
                sessionId: msg.sessionId,
              });
              ws.send(
                JSON.stringify({
                  type: "permission",
                  sessionId: msg.sessionId,
                  ...(pendingGate.prompt ? { prompt: pendingGate.prompt } : {}),
                  ...(pendingGate.detail ? { detail: pendingGate.detail } : {}),
                  options: pendingGate.options,
                  ...(pendingGate.cursor !== undefined ? { cursor: pendingGate.cursor } : {}),
                }),
              );
            }
            const pendingQuestion = this.pendingQuestions.get(msg.sessionId);
            if (pendingQuestion) {
              this.log.info(`[ws.replay_question] ${msg.sessionId.slice(0, 8)}`, {
                event: "ws.replay_question",
                sessionId: msg.sessionId,
              });
              ws.send(
                JSON.stringify({
                  type: "question",
                  sessionId: msg.sessionId,
                  toolUseId: pendingQuestion.toolUseId,
                  questions: pendingQuestion.questions,
                }),
              );
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
          // ptyGracePeriodMs === 0 disables the automatic hold-on-disconnect
          // timer; an explicit hold_session message still holds immediately.
          if (subscribers.size === 0 && this.ptyGracePeriodMs > 0) {
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
      if (this.ptyManager.hasSession(sessionId)) {
        // Never interrupt a session mid-response. A `running` PTY is actively
        // streaming a Claude turn that hasn't flushed to the JSONL yet; killing
        // it (SIGINT) would lose the in-flight answer. Re-arm the grace timer
        // and re-check after another grace period — it only becomes eligible
        // for hold once it settles back to waiting_input/idle.
        const resp = this.sessionStore.get(sessionId, this.ptyAttachedIds());
        if (resp?.status === "running") {
          this.log.info(
            `[grace] session ${sessionId} still running, deferring hold`,
            { sessionId, event: "pty.grace_defer" },
            "pino",
          );
          this.startGraceTimer(sessionId, delayMs);
          return;
        }
        this.sessionSubscribers.delete(sessionId);
        this.log.info(
          `[grace] killing idle PTY for ${sessionId}`,
          { sessionId, event: "pty.grace_kill" },
          "pino",
        );
        this.ptyManager.putOnHold(sessionId);
        const held = this.sessionStore.get(sessionId, this.ptyAttachedIds());
        if (held) this.wsHub.broadcast({ type: "session_update", session: held });
      } else {
        this.sessionSubscribers.delete(sessionId);
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
          // Cache-integrity drift monitor. reset_rescan rebuilds from a fresh
          // scan via the same machinery ?refresh=1 uses (rescanForRefresh).
          this.cacheMonitor = new CacheIntegrityMonitor(
            this.cache,
            this.wsHub,
            this.log,
            this.cacheDir,
            async () => {
              const scanner = await this.rescanForRefresh();
              return [...scanner.getMetadataCache().values()] as never;
            },
          );
          // Watch the active profile dirs (or ~/.claude/projects as fallback) so
          // new JSONL files created after startup are discovered and the scanner
          // and cache are invalidated without a restart. projectsDirs() is the
          // shared source of truth with findJsonlPath's degraded-mode discovery.
          for (const dir of this.projectsDirs()) {
            this.fileWatcher.watchDirectory(dir);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Loud, not swallowed: without the cache every /api/conversations*
          // request falls back to slower disk-only scans. The most common
          // cause is a better-sqlite3 ABI mismatch (node_modules built against
          // a different Node) — name the fix so it isn't rediscovered from a
          // bare failure. The serve preflight (check-sqlite-abi.ts) catches
          // the ABI case before we ever get here; this covers a cache that
          // dies for any other reason mid-run.
          const abiMismatch =
            message.includes("NODE_MODULE_VERSION") ||
            message.includes("was compiled against a different Node.js version");
          this.log.error(
            `ConversationCache failed to open — running WITHOUT cache; ` +
              `/api/conversations, /api/conversations/count and /project-chats serve from disk (degraded).` +
              (abiMismatch ? ` Fix: npm rebuild better-sqlite3` : "") +
              ` (${message})`,
            { error: message, abiMismatch, event: "cache.open_failed" },
          );
          // The scanner's persistent index uses the same better-sqlite3 module;
          // fall back to in-memory scans so requests keep working from disk.
          this.scannerPersistenceDisabled = true;
        }
        // Use a dedicated scanner for warm-up, independent of this.scanner, so
        // that onConversationChanged invalidations during the scan cannot cause
        // getScanner() to restart indefinitely and leave the warm-up stuck.
        const warmupStatCache = this.buildStatCache(null);
        // Scanner 0.9.4 reads statCache only in non-persistent scans.
        const warmupScanner = this.newScanner(warmupStatCache ? { persistent: false } : undefined);
        this.allScanners.add(warmupScanner);
        // Throttle the per-file onProgress firings to ~one frame per whole
        // percent (plus the final tick) so a large scan doesn't flood every
        // WebSocket client with thousands of scan_progress messages.
        const shouldEmitProgress = createScanProgressThrottle();
        const scanOpts = {
          ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
          ...this.codexScanOpts(),
          ...(warmupStatCache ? { statCache: warmupStatCache } : {}),
        };
        warmupScanner
          .scan({
            ...scanOpts,
            onProgress: (scanned, total) => {
              if (shouldEmitProgress(scanned, total)) {
                this.wsHub.broadcast({ type: "scan_progress", scanned, total });
              }
            },
          })
          .then(async () => {
            // Adopt the warm-up scan as the live scanner so the first real
            // request reuses it instead of paying for a second full scan.
            // Success path only — adopting a scanner whose scan rejected would
            // pair a broken engine with a resolved scannerReady, making every
            // later request throw instantly. Guard: only adopt if nothing else
            // already owns the slot.
            if (!this.scannerReady && !this.scanner) {
              this.scanner = warmupScanner;
              this.scannerReady = Promise.resolve();
            }
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
            // Detect cache/disk drift before the routine ghost prune. If a
            // pending alert is raised, freeze — skip pruneGhostFiles until a
            // human resolves it; otherwise prune exactly as before.
            await this.cacheMonitor?.runDetection();
            if (this.cacheMonitor?.pending) {
              this.log.warn("Startup ghost prune skipped — cache integrity alert pending", {
                fingerprint: this.cacheMonitor.pending.fingerprint,
                event: "cache.prune_ghosts_frozen",
              });
            } else {
              const pruned = this.cache.pruneGhostFiles();
              this.log.info(`Startup ghost prune: removed ${pruned.length} stale cache rows`, {
                count: pruned.length,
                event: "cache.prune_ghosts",
              });
            }
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`Startup cache warm-up failed: ${message}`, {
              error: message,
              event: "cache.warmup_failed",
            });
          })
          .finally(() => {
            this.cacheReady = true;
            this.wsHub.broadcast({ type: "cache_ready" });
            resolveWarm();
          });
      }
    });
    // Track the warm-up's scan→cache-write chain so close() can await it.
    this.trackCacheWrite(warmUp);
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

  // Register a fire-and-forget task that writes to this.cache after a scan, so
  // close() can await it before closing cache.db. Removes itself on settle. The
  // caller keeps its own error handling; this wrapper swallows rejections so a
  // failed task never rejects close()'s Promise.all.
  private trackCacheWrite(task: Promise<unknown>): void {
    const guarded = task.catch(() => undefined);
    this.inFlightCacheWrites.add(guarded);
    void guarded.finally(() => {
      this.inFlightCacheWrites.delete(guarded);
    });
  }

  // Single-flight + TTL wrapper for scanner.refreshFile. Both call sites (the
  // detail-stale branch and the per-turn refresh) route through here so that
  // N stacked retries on a live, actively-appended file cost one parse, not N:
  //  - a refresh already in flight for the path → await the same promise;
  //  - a refresh that settled within REFRESH_TTL_MS → skip, return null (the
  //    caller keeps serving the current snapshot);
  //  - otherwise start one, cache the promise, and stamp completedAt on settle.
  // The map is bounded by the active-file set (entries only live while a
  // refresh is in flight or within its TTL and are overwritten on the next
  // refresh of the same path).
  private refreshFileGuarded(
    scanner: ConversationScanner,
    filePath: string,
  ): Promise<Awaited<ReturnType<ConversationScanner["refreshFile"]>> | null> {
    const existing = this.refreshInFlight.get(filePath);
    if (existing) {
      const settled = existing.completedAt > 0;
      if (!settled) {
        // In flight: coalesce onto the same parse.
        return existing.promise as Promise<Awaited<
          ReturnType<ConversationScanner["refreshFile"]>
        > | null>;
      }
      if (Date.now() - existing.completedAt < REFRESH_TTL_MS) {
        // Completed recently enough: serve the snapshot, skip the parse.
        return Promise.resolve(null);
      }
    }
    const entry = { promise: Promise.resolve<unknown>(null), completedAt: 0 };
    entry.promise = scanner.refreshFile(filePath).finally(() => {
      entry.completedAt = Date.now();
    });
    this.refreshInFlight.set(filePath, entry);
    return entry.promise as Promise<Awaited<ReturnType<ConversationScanner["refreshFile"]>> | null>;
  }

  async close(): Promise<void> {
    for (const timer of this.ptyGraceTimers.values()) clearTimeout(timer);
    this.ptyGraceTimers.clear();
    this.markScannerStaleDebounced.cancel();
    // Wait for every fire-and-forget scan→cache-write task to finish before
    // tearing anything down. Their post-scan steps write to this.cache
    // (upsert / populateTail / pruneGhostFiles); closing cache.db under them
    // throws "database connection is not open" and leaves the cache empty
    // (deterministic once Stage 4's dir-mtime gate widened the scan window).
    // Snapshot the set — entries remove themselves as they settle.
    await Promise.all([...this.inFlightCacheWrites]);
    // Close all scanner SQLite connections before the cache so file handles are
    // released on Windows (open handles block temp-dir deletion in tests).
    // scanner.close() is async (scanner >=0.9.2): it awaits any in-flight scan
    // before releasing the DB handle, so a fire-and-forget refresh scan can't be
    // shut mid-indexAll(). Await all so handles are torn down only after scans
    // settle.
    await Promise.all([...this.allScanners].map((s) => s.close()));
    this.allScanners.clear();
    this.scanner = null;
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

  private rotateApiKey(): { newKey: string; persisted: boolean } {
    const oldKey = this.apiKey;
    const newKey = generateApiKey();
    // Only persist to server.yaml when the key came from there.
    // If --api-key was passed on the CLI, the flag wins on restart and
    // would silently revert to the old key — so skip the write and let
    // the caller know via the response.
    const persisted = this.apiKeySource === "config";
    if (persisted) setApiKey(newKey);
    this.apiKey = newKey;
    this.log.info("API key rotated", {
      event: "auth.api_key_rotated",
      oldKeyMasked: `${oldKey.slice(0, 6)}…`,
      newKeyMasked: `${newKey.slice(0, 6)}…`,
      persisted,
    });
    return { newKey, persisted };
  }

  private checkRateLimit(
    map: Map<string, number[]>,
    key: string,
    limit: number,
    windowMs: number,
  ): boolean {
    const now = Date.now();
    const arr = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      map.set(key, arr);
      return false;
    }
    arr.push(now);
    map.set(key, arr);
    // TTL-evict the entry once the window expires so the map doesn't grow unbounded.
    setTimeout(() => {
      const remaining = (map.get(key) ?? []).filter((t) => Date.now() - t < windowMs);
      if (remaining.length === 0) map.delete(key);
      else map.set(key, remaining);
    }, windowMs);
    return true;
  }

  private checkExchangeRateLimit(ip: string): boolean {
    return this.checkRateLimit(this.exchangeAttempts, ip, 5, 60_000);
  }

  private checkSessionStartRateLimit(ip: string): boolean {
    // 10 new sessions per minute per client IP
    return this.checkRateLimit(this.sessionStartAttempts, ip, 10, 60_000);
  }

  private checkSessionInputRateLimit(sessionId: string): boolean {
    // 500 keystrokes per minute per session
    return this.checkRateLimit(this.sessionInputAttempts, sessionId, 500, 60_000);
  }

  private async handleListConversations(url: URL, res: ServerResponse): Promise<void> {
    const limit = intParam(url, "limit", 50);
    const offset = intParam(url, "offset", 0);
    const sort = (url.searchParams.get("sort") ?? "recent") as SortOrder;
    const project = url.searchParams.get("project") ?? undefined;
    const providerFilter = url.searchParams.get("provider") ?? undefined;
    const bustCache = url.searchParams.get("refresh") === "1";

    // refresh=1 is a RECONCILE, not a wipe. The old path did
    // cache.invalidate() (deletes every row, including live-tailed ones) +
    // scanner=null (discards the warm scanner and forces a cold cache
    // rebuild). Instead: run one fresh full-glob scan (fullRescan bypasses the
    // scanner's dir-mtime gate — an explicit user refresh is the "check for
    // real" signal), then reconcile the cache from disk truth: upsert what
    // exists (newest-wins, so a concurrent live line still takes precedence),
    // and drop only the rows whose files no longer exist. Live-tailed rows are
    // never blanket-deleted, so an active conversation can't flicker out.
    if (bustCache && this.cache) {
      const scanner = await this.rescanForRefresh();
      const metas = [...scanner.getMetadataCache().values()];
      try {
        this.cache.upsertFromScannerMeta(metas as any[]);
        // Additions/updates are always safe. But while a cache-integrity alert
        // is pending, freeze the removal half — reconcileDeletions must not
        // drop rows until a human resolves the alert.
        if (!this.cacheMonitor?.pending) {
          const livePaths = new Set(
            metas.map((m) => m.filePath).filter((p): p is string => Boolean(p)),
          );
          this.cache.reconcileDeletions(livePaths);
        }
      } catch (err) {
        this.log.warn(
          `refresh reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
          { event: "conversations.reconcile_failed" },
        );
      }
    }

    if (this.cache) {
      const { conversations, total } = this.cache.listConversations({
        project,
        provider: providerFilter,
        limit,
        offset,
      });
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
        provider: c.provider ?? CLAUDE_CODE_PROVIDER,
      }));
      json(res, 200, { conversations: adapted, hasMore: offset + limit < total, offset, total });
      return;
    }

    const scanner = await this.getScanner();
    let metas = [...scanner.getMetadataCache().values()];
    metas = applyIncludeFilter(metas, "conversations");
    if (project) metas = applyProjectFilter(metas, project);
    if (providerFilter)
      metas = metas.filter((m) => (m.provider ?? CLAUDE_CODE_PROVIDER) === providerFilter);
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
        provider: (c as any).provider ?? CLAUDE_CODE_PROVIDER,
      };
    });
    json(res, 200, { conversations: adapted, hasMore: offset + limit < total, offset, total });
  }

  private async handleConversationsCount(url: URL, res: ServerResponse): Promise<void> {
    const project = url.searchParams.get("project") ?? undefined;
    const providerFilter = url.searchParams.get("provider") ?? undefined;
    const bustCache = url.searchParams.get("refresh") === "1";

    // refresh=1 historically forced a full synchronous scan() to recount from
    // disk. On a cold/empty index that scan walks every JSONL and blocks ~16s,
    // tripping mobile's request timeout into a false "unreachable". Mirror the
    // detail path's skipStaleRescan stance: serve the indexed/cached total
    // immediately and reconcile from disk in the BACKGROUND so the count stays
    // fast regardless of refresh.
    if (this.cache) {
      const { total } = this.cache.listConversations({
        project,
        provider: providerFilter,
        limit: 0,
        offset: 0,
      });
      json(res, 200, { total });
      if (bustCache) this.refreshCountInBackground();
      return;
    }

    const scanner = await this.getScanner(true);
    let metas = [...scanner.getMetadataCache().values()];
    metas = applyIncludeFilter(metas, "conversations");
    if (project) metas = applyProjectFilter(metas, project);
    if (providerFilter)
      metas = metas.filter((m) => (m.provider ?? CLAUDE_CODE_PROVIDER) === providerFilter);
    json(res, 200, { total: metas.length });
  }

  // Fire-and-forget full rescan that reconciles the SQLite cache from disk so a
  // later count reflects new/removed conversations. Never awaited by the request
  // path — refresh=1 returns the cached total synchronously and this catches up.
  private refreshCountInBackground(): void {
    // Tracked so close() awaits this scan→cache-write before closing cache.db.
    this.trackCacheWrite(
      (async () => {
        try {
          const scanner = await this.getFreshScanner();
          if (this.cache) {
            this.cache.upsertFromScannerMeta([...scanner.getMetadataCache().values()] as any[]);
          }
        } catch (err) {
          this.log.warn(
            `Background count refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            { event: "count.refresh_failed" },
          );
        }
      })(),
    );
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

  private buildStatCache(
    previousScanner: ConversationScanner | null,
  ): Map<string, { stat: FileStatEntry; meta: ConversationMeta }> | undefined {
    if (!this.cache) return undefined;
    if (!previousScanner) {
      const persisted = this.cache.getScannerStatCache();
      return persisted.size > 0 ? persisted : undefined;
    }
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

  // Returns the provider + codexRoots fragment to spread into every scan()/search() call.
  // codexRoots=[] disables codex scanning (safe no-op per scanner contract).
  private codexScanOpts() {
    return {
      providers: [CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER],
      codexRoots: this.codexRoots,
    };
  }

  // skipStaleRescan: when an indexed scanner already exists, return it directly
  // even if scannerStale is set, leaving the flag untouched so the next
  // list-level call still rescans. The single-conversation detail path passes
  // this — its per-file refreshFile (in findConversationByUuid) already
  // reconciles the one conversation being requested, so paying a full-tree
  // rescan just because some OTHER file changed is the stall this avoids.
  private newScanner(
    options?: ConstructorParameters<typeof ConversationScanner>[0],
  ): ConversationScanner {
    return new ConversationScanner(
      options ?? (this.scannerPersistenceDisabled ? { persistent: false } : undefined),
    );
  }

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
    // Scanner 0.9.4 reads statCache only in non-persistent scans.
    this.scanner = this.newScanner(statCache ? { persistent: false } : undefined);
    this.allScanners.add(this.scanner);
    this.scannerReady = this.scanner.scan({
      ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
      ...this.codexScanOpts(),
      ...(statCache ? { statCache } : {}),
    });
    try {
      await this.scannerReady;
    } catch (err) {
      // Don't memoize the rejection — a stored rejected promise would make
      // every future request replay this error instantly instead of retrying.
      this.scanner = null;
      this.scannerReady = null;
      throw err;
    }
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

  // refresh=1's scan: reuse the WARM scanner and re-run its scan with
  // fullRescan:true — the escape hatch that bypasses the scanner's
  // dir-mtime discovery gate, since an explicit user pull-to-refresh is exactly
  // the "don't trust the gate, check disk for real" signal. Unlike
  // getFreshScanner() this does NOT discard the warm scanner. scannerReady is
  // only ever reassigned to a live scan promise (never nulled mid-scan), so the
  // getScanner() anti-infinite-loop guard is preserved.
  private async rescanForRefresh(): Promise<ConversationScanner> {
    // Let any in-flight scan finish first so we don't run two scans on the same
    // index concurrently.
    if (this.scannerReady) await this.scannerReady;
    // A full rescan supersedes any pending staleness.
    this.scannerStale = false;
    if (!this.scanner) {
      this.scanner = new ConversationScanner();
      this.allScanners.add(this.scanner);
    }
    const scanner = this.scanner;
    this.scannerReady = scanner.scan({
      ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
      ...this.codexScanOpts(),
      fullRescan: true,
    });
    await this.scannerReady;
    return scanner;
  }

  /**
   * The projects dirs disk discovery should walk — the single source of truth
   * for "where do this server's JSONLs live", mirroring the warm-up watcher
   * (see listen()). Derived from the enabled scanProfiles' configDirs, or the
   * real ~/.claude/projects when no profiles are configured. An all-disabled
   * profile set intentionally yields [] (nothing to discover), matching the
   * watcher — it does NOT fall back to home in that case.
   */
  private projectsDirs(): string[] {
    if (this.scanProfiles && this.scanProfiles.length > 0) {
      return this.scanProfiles.filter((p) => p.enabled).map((p) => join(p.configDir, "projects"));
    }
    return [join(homedir(), ".claude", "projects")];
  }

  private findJsonlPath(uuid: string): string | null {
    const filename = `${uuid}.jsonl`;
    for (const projectsDir of this.projectsDirs()) {
      if (!existsSync(projectsDir)) continue;
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

  /**
   * Live Codex sessions keep `SessionResponse.conversationId === managed.id`
   * (stable deep-link / PTY key) and store the rollout UUID separately as
   * `boundConversationId`. REST history is indexed under the rollout UUID, so
   * resolve the placeholder → bound id before looking up the scanner.
   */
  private resolveConversationLookupId(uuid: string): string {
    const managed = this.sessionStore.getManaged(uuid);
    if (managed?.boundConversationId) return managed.boundConversationId;
    return uuid;
  }

  /** File path for a live managed session (placeholder id or bound Codex id). */
  private findLiveSessionFilePath(uuid: string): string | null {
    const direct = this.sessionFileMap.get(uuid);
    if (direct) return direct;
    for (const s of this.sessionStore.listManaged()) {
      if (s.boundConversationId === uuid) {
        return this.sessionFileMap.get(s.id) ?? null;
      }
    }
    return null;
  }

  /** True when a conversation UUID is the bound rollout of a live PTY session. */
  private isBoundConversationLive(boundId: string): boolean {
    for (const s of this.sessionStore.listManaged()) {
      if (s.boundConversationId === boundId && this.ptyManager.hasSession(s.id)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Broadcast conversation JSONL lines to WS clients. Codex rollout lines are
   * normalized to the Claude `type:user|assistant` shape mobile understands;
   * Claude lines pass through unchanged so seq alignment stays intact.
   */
  private broadcastConversationLines(
    sessionId: string,
    lines: string[],
    seqs?: (number | null)[] | null,
  ): void {
    const clientLines = toClientConversationLines(lines);
    if (clientLines.length === 0) return;
    const seqsOk = !!seqs && seqs.length === lines.length && clientLines.length === lines.length;
    this.wsHub.broadcast({
      type: "conversation_events",
      sessionId,
      lines: clientLines,
      ...(seqsOk ? { seqs } : {}),
    });
    // ...plus per-line conversation_event so older mobile clients,
    // which only know that shape, keep working byte-for-byte.
    for (const line of clientLines) {
      this.wsHub.broadcast({ type: "conversation_event", sessionId, line });
    }
  }

  private async findConversationByUuid(uuid: string): Promise<Conversation | null> {
    const lookupId = this.resolveConversationLookupId(uuid);

    // Cold-start fast path: until the warm-up scan has populated this.scanner
    // (this.scannerReady is null), do NOT trigger a full scan to answer a
    // single-conversation request — that scan walks every JSONL on disk and is
    // the 20s+ stall that makes mobile abort. Resolve the file directly
    // (findJsonlPath is an O(project-dirs) walk) and parse just that one file.
    // The warm-up scan keeps running in the background; once it adopts the
    // scanner, subsequent requests use the indexed hot path below.
    if (!this.scannerReady && !this.scanProfiles) {
      const filePath =
        this.findJsonlPath(lookupId) ??
        this.findLiveSessionFilePath(uuid) ??
        this.findLiveSessionFilePath(lookupId);
      if (filePath) {
        const account = this.cache?.getMetaById(lookupId)?.account ?? undefined;
        const coldScanner = this.scanner ?? this.newScanner();
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
    const fromIndex = await scanner.getConversation(lookupId);
    if (fromIndex) {
      // Live-session bypass: a conversation with a live PTY is exactly the case
      // that stalls — its mtime is always newer than the snapshot, so the stale
      // check below would refresh on every request. Serve the current snapshot
      // with no stale-check and no refresh. The live client is on WS receiving
      // conversation_event lines; the (TTL-throttled) turn-end refresh advances
      // the snapshot server-side; mobile refetches once on the running →
      // not-running transition, which is the reconcile point.
      // Codex: PTY is keyed by the placeholder session id, while the scanner
      // indexes the bound rollout UUID — check both.
      if (
        this.ptyManager.hasSession(uuid) ||
        this.ptyManager.hasSession(lookupId) ||
        this.isBoundConversationLive(lookupId)
      ) {
        // Codex live sessions: the scanner LRU snapshot is often frozen at bind
        // time (mtime always looks "live", so SWR never refreshes). Re-parse the
        // watched rollout so REST history includes turns written after bind.
        // Claude keeps the cheap bypass — its offset index + WS seq path stay fresh.
        const livePath =
          this.findLiveSessionFilePath(uuid) ??
          this.findLiveSessionFilePath(lookupId) ??
          fromIndex.filePath ??
          null;
        const isCodexLive =
          this.isBoundConversationLive(lookupId) ||
          this.sessionStore.getManaged(uuid)?.provider === CODEX_CLI_PROVIDER;
        if (isCodexLive && livePath) {
          try {
            const account =
              this.cache?.getMetaById(lookupId)?.account ??
              (fromIndex as { account?: string }).account ??
              undefined;
            const page = await scanner.parseSingleFilePage(livePath, account, {
              limit: Number.MAX_SAFE_INTEGER,
            });
            if (page?.conversation) return page.conversation;
          } catch (err) {
            this.log.warn("codex.live_reparse_failed", {
              event: "codex.live_reparse_failed",
              conversationId: lookupId,
              filePath: livePath,
              err,
            });
          }
        }
        return fromIndex;
      }
      // The scanner memoizes both its metadata index and parsed conversations
      // for the server's lifetime. A conversation that grows after the initial
      // scan (the chokidar watcher keeps the SQLite cache fresh, but never the
      // scanner) keeps serving the startup snapshot here — so the detail/info
      // view shows a stale message count + last activity that disagrees with
      // the list view and with what --resume actually replays.
      //
      // Stale-while-revalidate: since a snapshot already exists, respond from it
      // immediately and refresh the one file's indexes in the background
      // (single-flighted + TTL-throttled via refreshFileGuarded, tracked so
      // close() awaits it). The next request after the refresh settles sees the
      // fresh data. Only a conversation with NO snapshot pays the parse
      // synchronously (the getConversation-null fallthrough below), so a cold
      // thundering herd costs one parse, not N.
      if (fromIndex.filePath && this.isConversationSnapshotStale(fromIndex)) {
        const filePath = fromIndex.filePath;
        this.trackCacheWrite(
          this.refreshFileGuarded(scanner, filePath).catch((err) => {
            this.log.warn("scanner.refreshFile: failed", {
              event: "scanner.refresh_failed",
              conversationId: uuid,
              filePath,
              trigger: "detail-swr",
              err,
            });
          }),
        );
      }
      return fromIndex;
    }

    if (this.scanProfiles) return null;

    const filePath =
      this.findJsonlPath(lookupId) ??
      this.findLiveSessionFilePath(uuid) ??
      this.findLiveSessionFilePath(lookupId);
    if (!filePath) return null;
    this.scanner = null;
    this.scannerReady = null;
    const freshScanner = await this.getScanner();
    return freshScanner.getConversation(lookupId);
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
          const cachedProvider = cachedMeta?.provider ?? CLAUDE_CODE_PROVIDER;
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
              provider: cachedProvider,
              resumable: isProviderResumable(cachedProvider, availability.resumable),
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
    // Fold the offset index's count into the validator: when the index is
    // fresher than the scanner snapshot (a live/appended file), the ETag must
    // change so a client holding the old tail doesn't get a 304 against grown
    // content. Cheap count lookup; the window read below reuses the same number.
    const indexedCount =
      etagSource.filePath && this.cache
        ? this.cache.getIndexedMessageCount(
            ConversationCache.conversationIdForFile(etagSource.filePath),
          )
        : 0;
    const etagMessageCount = Math.max(etagSource.messageCount, indexedCount);
    const etag = computeConversationEtag({
      filePath: etagSource.filePath,
      messageCount: etagMessageCount,
      timestamp: etagSource.timestamp,
    });

    // Only the first page ("is the conversation as a whole still current?")
    // participates in the freshness check. Older pages are immutable history —
    // a back-page request (before_index set) always returns its 200 body, never
    // a 304, even when the client echoes a matching If-None-Match. Anchored and
    // after-windows also always return 200: their ETag inputs are identical to
    // the tail page's, so honoring If-None-Match here would 304 a client that
    // holds the tail page but is asking for a different window.
    const isFirstPage =
      !url.searchParams.has("before_index") &&
      !url.searchParams.has("anchor_index") &&
      !url.searchParams.has("after_index");
    if (isFirstPage && ifNoneMatch && ifNoneMatch === etag) {
      // This is a direct-`ServerResponse` write, so the Hono CORS middleware's
      // headers don't reach it — set the expose header here so a cross-origin
      // client can read the validator off the 304 too.
      res.writeHead(304, { ETag: etag, "Access-Control-Expose-Headers": "ETag" });
      res.end();
      return;
    }

    // Codex writes AGENTS.md / permissions dumps as role:user before any real
    // turn. Drop them from the REST payload so the chat opens as user→agent
    // rather than fake-user→fake-user→agent. Heuristic is Codex-specific text;
    // Claude messages never match.
    const filtered = conversation.messages.filter(
      (m) => !(m.role === "user" && typeof m.text === "string" && isCodexInjectedContext(m.text)),
    );
    const total = filtered.length;

    const hasAnchor = url.searchParams.has("anchor_index");
    const hasAfter = url.searchParams.has("after_index");
    const usePaging =
      url.searchParams.has("msg_limit") ||
      url.searchParams.has("before_index") ||
      hasAnchor ||
      hasAfter;

    let slice = filtered;
    let fromIdx = 0;
    let messagePagination: Record<string, unknown> | undefined;
    // Set to the offset index's total when it served this response, so the meta
    // block can reflect the freshly-indexed count/timestamp instead of the
    // (possibly stale) scanner snapshot.
    let indexTotal: number | null = null;

    if (usePaging) {
      const limit = Math.min(Math.max(intParam(url, "msg_limit", 80), 1), 500);
      let beforeIndex = total;
      let scanLimit = limit;
      let anchorIndex: number | null = null;
      let newerPaging = false;
      // True only when the after_index branch actually ran (before_index takes
      // precedence over after_index, so `hasAfter` alone isn't enough).
      let usedAfterIndex = false;
      if (url.searchParams.has("before_index")) {
        beforeIndex = intParam(url, "before_index", total);
        beforeIndex = Math.min(Math.max(beforeIndex, 0), total);
      } else if (hasAfter) {
        // Newer-direction page: [after_index, after_index + limit). The paged
        // reader is end-anchored, so cap its limit at the window width — a full
        // `limit` near the tail would widen the window backward over rows the
        // client already has (duplicate message_index rows on mobile).
        const from = Math.min(Math.max(intParam(url, "after_index", 0), 0), total);
        beforeIndex = Math.min(total, from + limit);
        scanLimit = beforeIndex - from;
        newerPaging = true;
        usedAfterIndex = true;
      } else if (hasAnchor) {
        // Centered window around the anchor, clamped into [0, total-1] — a
        // stale index from search must still open the conversation, never 400.
        // Near the tail the window widens backward so it stays full-size.
        anchorIndex = Math.min(
          Math.max(intParam(url, "anchor_index", 0), 0),
          Math.max(0, total - 1),
        );
        const from = Math.max(0, anchorIndex - Math.floor(limit / 2));
        beforeIndex = Math.min(total, from + limit);
        newerPaging = true;
      }
      // A plain tail request (no explicit cursor) means "the newest `limit`
      // messages". Its window was derived from the scanner's snapshot `total`,
      // which lags a live, actively-appended file — the exact case the offset
      // index exists to serve. When the index is fresher than the snapshot,
      // anchor the tail on the INDEX's total so newly-appended messages aren't
      // dropped by a stale upper bound.
      const isTailRequest = !url.searchParams.has("before_index") && !hasAfter && !hasAnchor;
      const indexFilePath = (conversation as { filePath?: string }).filePath;
      if (isTailRequest && indexFilePath && this.cache) {
        const indexed = this.cache.getIndexedMessageCount(
          ConversationCache.conversationIdForFile(indexFilePath),
        );
        if (indexed > beforeIndex) {
          beforeIndex = indexed;
        }
      }
      const windowStart = Math.max(0, beforeIndex - scanLimit);

      // Offset-index fast path: when the index is warm and matches the file on
      // disk, serve the window straight from SQLite + pread of the exact byte
      // ranges — no scanner, no re-parse. Falls through to the scanner (and
      // enqueues a backfill) on any miss/mismatch so the response is never
      // wrong. Only for the linear paging windows (before/after/tail); the
      // anchored-search window keeps using the scanner's reader.
      const indexWindow =
        scanLimit > 0 && !hasAnchor && indexFilePath && this.cache
          ? this.cache.readMessageWindow(indexFilePath, windowStart, beforeIndex)
          : null;
      if (!indexWindow && indexFilePath && this.cache && !hasAnchor) {
        // Cold/stale index for a file we page linearly → backfill in the
        // background (tracked so close() awaits it) for next time. The current
        // request is served by the scanner path below.
        this.trackCacheWrite(
          this.cache.backfillIndex(indexFilePath).catch((err) => {
            this.log.warn("offset-index.backfill_failed", {
              event: "offset_index.backfill_failed",
              conversationId: id,
              filePath: indexFilePath,
              err,
            });
          }),
        );
      }

      // Only consult the scanner's paged reader when it's already warm. On the
      // cold path `conversation` came from the single-file fast path and holds
      // every message in memory, so slice it locally — calling getScanner()
      // here would trigger the full scan the fast path exists to avoid. Pass
      // skipStaleRescan: this is the same single-conversation detail path, whose
      // refreshFile already reconciled the one file we page here, so a sibling
      // file's stale flag must not stall this read behind a full-tree rescan.
      // Prefer the offset-index window when warm (Claude). Otherwise slice the
      // in-memory `filtered` list — do NOT call getConversationPage here.
      // That helper re-reads the scanner LRU (unfiltered, often stale for live
      // Codex) and would bypass isCodexInjectedContext, which is exactly how
      // mobile's ?msg_limit=80 path lost real user turns / showed PTY-only UI.
      const page = indexWindow;
      if (indexWindow) indexTotal = indexWindow.total;
      const start = page?.fromIndex ?? windowStart;
      slice = page?.messages ?? filtered.slice(start, beforeIndex);
      fromIdx = start;
      const effectiveTotal = page?.total ?? total;
      messagePagination = {
        total: effectiveTotal,
        before_index: beforeIndex,
        from_index: start,
        has_more_older: start > 0,
        next_before_index: start > 0 ? start : null,
      };
      if (anchorIndex != null) messagePagination.anchor_index = anchorIndex;
      if (newerPaging) {
        messagePagination.has_more_newer = beforeIndex < effectiveTotal;
        messagePagination.next_after_index = beforeIndex < effectiveTotal ? beforeIndex : null;
      }
      // Delta-validity token: an after_index delta carries the conversation's
      // current etag so a client can detect that its stored cursor is stale
      // (etag mismatch → discard the cursor, refetch the tail). Only on the
      // forward-delta path (before_index takes precedence, so gate on the flag
      // not merely hasAfter); additive, so old clients ignore it.
      if (usedAfterIndex) {
        messagePagination.etag = etag;
      }
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
    const cachedConvMeta = this.cache?.getMetaById(id);
    const convProvider = coerceProviderForRunner(conv.provider ?? cachedConvMeta?.provider);
    const availability = classifyResumability(conv.projectPath);
    // When the offset index served a fresher view than the scanner snapshot,
    // the meta (message_count / last_updated_at) must reflect what was actually
    // served — otherwise meta disagrees with the messages array. Prefer the
    // index total and the newest served message's timestamp.
    const metaMessageCount =
      indexTotal != null && indexTotal > conv.messageCount ? indexTotal : conv.messageCount;
    const metaLastUpdatedAt =
      indexTotal != null && indexTotal > conv.messageCount
        ? (slice.at(-1)?.timestamp ?? conv.timestamp)
        : conv.timestamp;
    const body: Record<string, unknown> = {
      meta: {
        id,
        profile_id: conv.account,
        project_name: conv.projectName,
        project_path: conv.projectPath,
        file_path: conv.filePath,
        last_updated_at: metaLastUpdatedAt,
        message_count: metaMessageCount,
        last_prompt: conv.lastPrompt ?? undefined,
        provider: convProvider,
        resumable: isProviderResumable(convProvider, availability.resumable),
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

  // Resolves an active search query to the message a client should anchor to
  // inside one conversation. Matching is body-only (text first, then
  // thinking/tool payloads) — a metadata-only search hit (project path, title)
  // has no scroll target and returns 404 search_target_not_found.
  //
  // Implements HTTP QUERY (RFC 10008): the search query travels in a JSON
  // request body instead of a URL query param — QUERY is safe + idempotent +
  // cacheable like GET, but (like POST) can carry a body, which fits this
  // endpoint's single-string input exactly. `Accept-Query` advertises the
  // supported request media type per the spec.
  private async handleSearchTarget(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    if (contentType && contentType !== "application/json") {
      res.setHeader("Accept-Query", "application/json");
      json(res, 415, {
        error: "Unsupported Content-Type; expected application/json",
        code: "unsupported_media_type",
      });
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      res.setHeader("Accept-Query", "application/json");
      json(res, 422, { error: "Malformed JSON body", code: "invalid_query" });
      return;
    }

    const q =
      typeof (body as { q?: unknown })?.q === "string" ? (body as { q: string }).q.trim() : "";
    if (!q) {
      res.setHeader("Accept-Query", "application/json");
      json(res, 422, { error: "Missing or empty query field: q", code: "invalid_query" });
      return;
    }
    if (q.length > 256) {
      res.setHeader("Accept-Query", "application/json");
      json(res, 422, { error: "Query too long (max 256 characters)", code: "invalid_query" });
      return;
    }

    const conversation = await this.findConversationByUuid(id);
    if (!conversation) {
      json(res, 404, { error: "Conversation not found", code: "not_found" });
      return;
    }

    const target = findSearchTarget(conversation.messages as unknown as SearchableMessage[], q);
    if (!target) {
      json(res, 404, { error: "No message body matches query", code: "search_target_not_found" });
      return;
    }

    res.setHeader("Accept-Query", "application/json");
    json(res, 200, {
      query: q,
      message_index: target.messageIndex,
      uuid: target.uuid,
      snippet: target.snippet,
      match_indexes: target.matchIndexes,
      total_matches: target.totalMatches,
    });
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
        ...this.codexScanOpts(),
      },
      scanner,
    );
    const adapted = results.map((r: any) => ({
      // Use sessionId so the id matches /api/conversations and resolves via
      // findConversationByUuid — a client can round-trip a search result into
      // GET /api/conversations/:id or the search-target QUERY. The old
      // filename-stem derivation produced an id no other endpoint recognized.
      id: r.meta.sessionId || r.meta.id,
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
      provider: r.meta.provider ?? CLAUDE_CODE_PROVIDER,
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
        // The cache can keep a "tailed ghost" row (JSONL deleted out-of-band,
        // e.g. bulk branch/worktree cleanup) so its history stays viewable via
        // GET /:id — see pruneGhostFiles(). It can never be resumed though, so
        // give a distinct, non-retryable reason instead of a generic 404 that
        // sends mobile into a retry loop.
        json(res, 404, {
          error: "Conversation history file is missing; it can no longer be resumed",
          code: "history_file_missing",
        });
        return;
      }
      json(res, 400, { error: "Could not determine project path" });
      return;
    }

    // Same provider-resolution fallback as the conversation-detail path
    // (server.ts ~1685): `conv` (the full Conversation shape) doesn't carry
    // provider, so fall back to the cached metadata, then default to Claude.
    const cachedConvMeta = this.cache?.getMetaById(sessionId);
    const provider = coerceProviderForRunner((conv as any)?.provider ?? cachedConvMeta?.provider);

    const session = await this.ptyManager.start(sessionId, {
      provider,
      projectPath,
      projectName: body.projectName,
      branch: body.branch,
      permissionMode: this.defaultPermissionMode,
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
    if (!this.checkSessionInputRateLimit(sessionId)) {
      json(res, 429, { error: "Too many input requests for this session. Please slow down." });
      return;
    }
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

  private cancelPendingQuestion(sessionId: string): void {
    const pq = this.pendingQuestions.get(sessionId);
    if (!pq) return;
    this.pendingQuestions.delete(sessionId);
    this.pendingQuestionKey.delete(sessionId);
    this.wsHub.broadcast({ type: "question_cancelled", sessionId, toolUseId: pq.toolUseId });
  }

  // Live AskUserQuestion detected from the rendered screen (ahead of JSONL).
  // Broadcasts the `question` event immediately and records the content key so
  // the later JSONL flush of the same question is de-duped. We synthesize a
  // screen-scoped toolUseId; the JSONL path overwrites pendingQuestions with the
  // real toolUseId when it lands, so answering works once JSONL catches up.
  private handleLiveQuestion(sessionId: string, questions: AskQuestion[]): void {
    const key = questionContentKey(questions);
    if (this.pendingQuestionKey.get(sessionId) === key) return; // already shown
    const toolUseId = `screen:${sessionId}:${key.length}`;
    this.pendingQuestions.set(sessionId, { toolUseId, questions });
    this.pendingQuestionKey.set(sessionId, key);
    this.wsHub.broadcast({ type: "question", sessionId, toolUseId, questions });
  }

  // Permission gate opened/closed (OSC 777 + scraped options). Broadcasts the
  // additive `permission` / `permission_cancelled` events. Mobile answers by
  // sending the chosen option index via /input { keys } (e.g. "2\r").
  private handlePermissionChange(
    sessionId: string,
    gate: {
      prompt?: string;
      detail?: string;
      options: PermissionOption[];
      cursor?: number;
    } | null,
  ): void {
    if (gate === null) {
      if (!this.pendingPermission.has(sessionId)) return;
      this.pendingPermission.delete(sessionId);
      this.wsHub.broadcast({ type: "permission_cancelled", sessionId });
      return;
    }
    this.pendingPermission.set(sessionId, gate);
    const subscriberCount = this.sessionSubscribers.get(sessionId)?.size ?? 0;
    this.log.info(
      `[ws.broadcast_permission] ${sessionId.slice(0, 8)} subscribers=${subscriberCount}`,
      { event: "ws.broadcast_permission", sessionId, subscriberCount },
    );
    this.wsHub.broadcast({
      type: "permission",
      sessionId,
      ...(gate.prompt ? { prompt: gate.prompt } : {}),
      ...(gate.detail ? { detail: gate.detail } : {}),
      options: gate.options,
      ...(gate.cursor !== undefined ? { cursor: gate.cursor } : {}),
    });
  }

  private async handleSendAnswer(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    const pending = this.pendingQuestions.get(sessionId);
    const resolution = resolveAnswer(pending, body);
    if (!resolution.ok) {
      json(res, 400, { ok: false, reason: resolution.reason });
      return;
    }
    // pending is guaranteed defined when resolution.ok is true (resolveAnswer guards it)
    const toolUseId = pending?.toolUseId ?? "";
    try {
      this.ptyManager.sendKeys(sessionId, resolution.keys);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send answer";
      json(res, 400, { ok: false, reason: message });
      return;
    }
    this.pendingQuestions.delete(sessionId);
    this.wsHub.broadcast({ type: "question_cancelled", sessionId, toolUseId });
    json(res, 200, { ok: true });
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

  private async handleStopSession(sessionId: string, res: ServerResponse): Promise<void> {
    const STOP_TIMEOUT_MS = 5000;

    const session = this.ptyManager.getSession(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    if (session.status === "idle") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "already_idle", sessionId }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    res.write(`${JSON.stringify({ event: "stopping", sessionId })}\n`);

    const idlePromise = new Promise<"idle">((resolve) => {
      const handler = (status: string) => {
        if (status === "idle") {
          this.sessionStatusBus.off(`status:${sessionId}`, handler);
          resolve("idle");
        }
      };
      this.sessionStatusBus.on(`status:${sessionId}`, handler);
    });

    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS),
    );

    this.ptyManager.putOnHold(sessionId);
    this.discoveryCache = null;

    const outcome = await Promise.race([idlePromise, timeoutPromise]);

    if (outcome === "idle") {
      res.write(`${JSON.stringify({ event: "stopped", sessionId })}\n`);
    } else {
      res.write(`${JSON.stringify({ event: "timeout", sessionId })}\n`);
      this.log.warn(
        `[stop] session ${sessionId.slice(0, 8)} did not idle within ${STOP_TIMEOUT_MS}ms`,
      );
    }

    res.end();
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
      permissionMode: this.defaultPermissionMode,
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
    const ip = req.socket?.remoteAddress ?? "unknown";
    if (!this.checkSessionStartRateLimit(ip)) {
      json(res, 429, {
        error: "Too many session start requests. Please wait before trying again.",
      });
      return;
    }
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
    const body = await readBody(req);
    const { path: relativePath, provider: requestedProvider, systemPrompt: clientPrompt } = body;

    if (requestedProvider !== undefined && !isProviderName(requestedProvider)) {
      json(res, 400, { error: "Invalid provider" });
      return;
    }
    const provider = requestedProvider ?? CLAUDE_CODE_PROVIDER;

    if (!this.browseRoot) {
      json(res, 403, {
        error: "File browsing not configured. Set browseRoot on the server.",
        code: "BROWSE_ROOT_NOT_SET",
      });
      return;
    }

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

    const systemPromptParts = [
      this.defaultSystemPrompt,
      BROWSE_SYSTEM_PROMPT(this.browseRoot),
      typeof clientPrompt === "string" ? clientPrompt : null,
    ].filter(Boolean);

    try {
      const session = await this.ptyManager.startFresh({
        provider,
        projectPath: resolvedPath,
        projectName: body.projectName,
        systemPrompt: systemPromptParts.join("\n"),
        permissionMode: this.defaultPermissionMode,
      });

      this.sessionStore.addManaged(session);

      // Block for the PTY to actually reach waiting_input (or fail) so the
      // caller gets a trustworthy status instead of navigating on a guess.
      // Races against the same fallback window pty-manager itself uses for
      // prompt-marker detection, plus margin — if neither settles in time we
      // fall back to the old fire-and-forget shape rather than hang the request.
      const readyOrFailed = new Promise<"ready" | "failed">((resolve) => {
        const handler = (status: string) => {
          if (status === "waiting_input" || status === "idle") {
            this.sessionStatusBus.off(`status:${session.id}`, handler);
            resolve(status === "waiting_input" ? "ready" : "failed");
          }
        };
        this.sessionStatusBus.on(`status:${session.id}`, handler);
      });
      const timeoutPromise = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), START_READY_TIMEOUT_MS),
      );

      const outcome = await Promise.race([readyOrFailed, timeoutPromise]);
      const current = this.sessionStore.get(session.id, this.ptyAttachedIds());

      if (outcome === "ready" && current) {
        json(res, 200, { session: current });
      } else if (outcome === "failed" && current) {
        json(res, 502, {
          id: session.id,
          status: "idle",
          error: current.failureReason ?? "Session exited before becoming ready",
        });
      } else {
        // Timeout, or session vanished from the store — old async contract.
        json(res, 202, { id: session.id, status: "pending" });
      }

      if (provider === CODEX_CLI_PROVIDER) {
        // Wire up rollout-file binding once Codex creates its persisted session.
        this.watchForCodexRollout(session.id, resolvedPath);
      } else {
        // Wire up JSONL watching once Claude creates the conversation file.
        this.watchForJsonl(session.id, resolvedPath);
      }

      this.broadcastOrUnicastSessionList(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start session";
      const statusCode =
        typeof (err as Error & { statusCode?: unknown }).statusCode === "number"
          ? (err as Error & { statusCode: number }).statusCode
          : 500;
      this.log.error(`[start] failed to start session: ${message}`, {
        event: "session.start_failed",
        error: message,
      });
      json(res, statusCode, { error: message });
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
          this.broadcastConversationLines(sessionId, existing);
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

  // Codex-equivalent of watchForJsonl(). Differs because Codex has no
  // filename-encoded session id (it assigns its own persisted id) and its
  // rollout files live under a date-nested directory
  // (~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl) that Codex creates
  // itself — it may not exist yet when this function is first called, so we
  // poll rather than fs.watch a not-yet-existent directory. Per Phase 0
  // findings, the rollout file appears within ~1s of process spawn (after
  // any directory-trust gate is cleared), well before any user input.
  private watchForCodexRollout(sessionId: string, projectPath: string): void {
    const deadline = Date.now() + 120_000;
    const now = new Date();
    const dateDir = join(
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );

    // When this placeholder session started. Used to reject a stale same-cwd
    // rollout that Codex wrote before this session launched — the cwd match
    // alone can't tell a fresh rollout from a seconds-old one. 5s of slack
    // absorbs clock skew between our clock and Codex's session_meta timestamp.
    const sessionStartedAtMs =
      (this.sessionStore.getManaged(sessionId)?.startedAt?.getTime() ?? Date.now()) - 5_000;

    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (intervalHandle) clearInterval(intervalHandle);
      intervalHandle = null;
    };

    // Read a candidate file's session_meta first line; accept only if its cwd
    // matches this session's projectPath and it was created at/after this
    // session started. Guards against picking up an unrelated concurrent Codex
    // session's rollout, or a stale same-cwd rollout from an earlier run, in
    // the same date-nested directory. Returns { id, createdAtMs } or null.
    const matchesProjectPath = (
      candidatePath: string,
    ): { id: string; createdAtMs: number } | null => {
      try {
        const firstLine = readFileSync(candidatePath, "utf8").split("\n", 1)[0];
        if (!firstLine) return null;
        const parsed = JSON.parse(firstLine);
        if (parsed?.type !== "session_meta") return null;
        const payload = parsed.payload ?? {};
        if (payload.cwd !== projectPath) return null;
        if (typeof payload.id !== "string") return null;
        // payload.timestamp is Codex's session-creation time; fall back to the
        // outer envelope timestamp if absent.
        const createdIso = payload.timestamp ?? parsed.timestamp;
        const createdAtMs = typeof createdIso === "string" ? Date.parse(createdIso) : Number.NaN;
        if (Number.isNaN(createdAtMs) || createdAtMs < sessionStartedAtMs) return null;
        return { id: payload.id, createdAtMs };
      } catch {
        return null;
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

      // Codex ids already bound to another live placeholder — never bind two
      // placeholders to the same rollout (e.g. two Codex sessions started in
      // the same project inside the mtime window).
      const boundElsewhere = new Set(
        this.sessionStore
          .listManaged()
          .filter((s) => s.id !== sessionId && s.boundConversationId != null)
          .map((s) => s.boundConversationId as string),
      );

      for (const root of this.codexRoots) {
        const sessionsDir = join(root, dateDir);
        if (!existsSync(sessionsDir)) continue;

        let candidateFiles: string[];
        try {
          candidateFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }

        const nowMs = Date.now();
        const recentCandidates = candidateFiles
          .map((f) => ({ f, mtime: statSync(join(sessionsDir, f)).mtimeMs }))
          .filter(({ mtime }) => nowMs - mtime < 10_000)
          .sort((a, b) => b.mtime - a.mtime);

        for (const { f } of recentCandidates) {
          const candidatePath = join(sessionsDir, f);
          const match = matchesProjectPath(candidatePath);
          if (!match) continue;
          if (boundElsewhere.has(match.id)) continue;
          const codexSessionId = match.id;

          cleanup();
          this.sessionStore.updateManaged(sessionId, { boundConversationId: codexSessionId });

          // Wire the bound rollout into the live update path: tail it for
          // structured events and replay anything already written before the
          // watcher attached (mirrors watchForJsonl()). Without this the bound
          // Codex JSONL is never live-streamed to clients.
          this.sessionFileMap.set(sessionId, candidatePath);
          this.fileWatcher.watch(candidatePath);
          try {
            const existing = readFileSync(candidatePath, "utf8").split("\n").filter(Boolean);
            if (existing.length > 0) {
              this.broadcastConversationLines(sessionId, existing);
            }
          } catch {
            /* ignore — file may not be readable yet; watcher will catch future writes */
          }

          if (this.scannerReady) {
            this.scannerStale = true;
          } else {
            this.scanner = null;
          }
          this.linkSessionToProject(sessionId, projectPath, candidatePath);
          this.cache?.markAsStreamer(sessionId);

          // Push the binding to subscribers now — the async discovery means the
          // session_update at start time carried no boundConversationId.
          const resp = this.sessionStore.get(sessionId, this.ptyAttachedIds());
          if (resp) {
            this.wsHub.broadcast({ type: "session_update", session: resp });
          }

          this.log.info(
            `[startFresh] bound Codex rollout for ${sessionId}`,
            {
              event: "session.codex_rollout_bound",
              sessionId,
              boundConversationId: codexSessionId,
              filePath: candidatePath,
            },
            "pino",
          );
          return;
        }
      }
    };

    tryWire();
    if (!intervalHandle && Date.now() <= deadline) {
      // Only keep polling if tryWire() didn't already find + cleanup() the match.
      const alreadyBound = this.sessionStore.getManaged(sessionId)?.boundConversationId != null;
      if (!alreadyBound) {
        intervalHandle = setInterval(tryWire, 250);
      }
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
  const provider = c.provider ?? CLAUDE_CODE_PROVIDER;
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
    provider,
    resumable: isProviderResumable(provider, availability.resumable),
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
