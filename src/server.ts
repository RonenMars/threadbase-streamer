import { createNodeWebSocket } from "@hono/node-ws";
import { Connection, Client as TemporalClient } from "@temporalio/client";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { existsSync, statSync } from "fs";
import { realpath } from "fs/promises";
import type { Hono } from "hono";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { homedir, hostname } from "os";
import { dirname, join } from "path";
import type { WebSocket } from "ws";
import { type AgentClient, createAgentClient } from "./agent/agent-client";
import { type AgentConfig, readAgentConfig } from "./agent/agent-config";
import { type ConversationWriter, createConversationWriter } from "./agent/conversation-writer";
import { type AppEnv, createHonoApp } from "./api/app";
import { ConversationHandlers } from "./api/handlers/conversations.handlers";
import { json, readBody, writeHonoResponse } from "./api/handlers/http-helpers";
import { SessionHandlers } from "./api/handlers/sessions.handlers";
import { ALREADY_HANDLED } from "./api/routes/sessions.routes";
import { createWsRoutes } from "./api/routes/ws.routes";
import type { ApiDeps } from "./api/types/api-deps";
import {
  generateApiKey,
  loadBrowseRoot,
  loadBrowserCors,
  loadCacheDir,
  loadClaudeExtraArgs,
  loadClaudeFlags,
  loadDefaultPermissionMode,
  loadFeatureFlags,
  loadPublicUrl,
  loadTailSize,
  setApiKey,
  setClaudeExtraArgs,
  setClaudeFlags,
  validatePublicUrl,
} from "./auth";
import {
  BrowsePathNotFoundError,
  createDirectory,
  listDirectories,
  listFiles,
  resolveBrowsePath,
} from "./browse";
import {
  CLAUDE_FLAGS,
  type ClaudeFlagValues,
  EFFORT_LEVELS,
  type EffortLevel,
  isEffortLevel,
  isPermissionMode,
  type PermissionMode,
  validateFlagValues,
} from "./claude-flags";
import { ConversationCache } from "./conversation-cache";
import { createPool, getDbConfig, maskConnectionString, runMigrations } from "./db";
import { CacheMetadataRepository } from "./db/repositories/cacheMetadata.repository";
import { ConversationsRepository } from "./db/repositories/conversations.repository";
import { DevicesRepository } from "./db/repositories/devices.repository";
import { ManagedSessionsRepository } from "./db/repositories/managed-sessions.repository";
import { ProjectsRepository } from "./db/repositories/projects.repository";
import { PushRepository } from "./db/repositories/push.repository";
import { SessionsRepository } from "./db/repositories/sessions.repository";
import { RuntimeStore } from "./db/runtime-store";
import { type ExternalTailEntry, ExternalTailManager } from "./external-tails";
import {
  FEATURE_FLAGS,
  type FeatureFlagValues,
  nonDefaultFeatureFlags,
  resolveFeatureFlags,
} from "./feature-flags";
import { handleListProjects } from "./handlers/handleListProjects";
import { LiveSessionManager } from "./live-session-manager";
import { getLogger } from "./logger";
import { PairTokenStore } from "./pair-store";
import { CLAUDE_CODE_PROVIDER, coerceProviderForRunner, type ProviderName } from "./providers";
import { PtyHostProtocolMismatchError } from "./pty-host/remote-session-runner";
import { connectOrSpawnHost } from "./pty-host/spawn-host";
import { ScannerManager } from "./scanner-manager";
import { seal } from "./seal";
import { setCacheMetadata } from "./services/cache/cacheMetadata";
import { CacheIntegrityMonitor } from "./services/cache-integrity/cacheIntegrityMonitor";
import { ConversationWatcher } from "./services/conversations/conversationWatcher";
import { parseAgentEntrypointsEnv } from "./services/conversations/isAgentConversation";
import { pruneAgentConversations } from "./services/conversations/pruneAgentConversations";
import { refreshConversationCache } from "./services/conversations/refreshConversationCache";
import {
  ApnsClient,
  describeMissingApnsCredentials,
  readApnsCredentialsFromEnv,
} from "./services/push/apnsClient";
import { ExpoPushSender } from "./services/push/expoPushSender";
import { LiveActivityNotifier } from "./services/push/liveActivityNotifier";
import { LiveActivityRenewalScheduler } from "./services/push/liveActivityRenewal";
import { LiveActivitySender } from "./services/push/liveActivitySender";
import { WaitingInputNotifier } from "./services/push/waitingInputNotifier";
import { questionContentKey } from "./services/questions/detectQuestionFromScreen";
import {
  questionsFromLines,
  shouldBroadcastQuestion,
} from "./services/questions/questionBroadcast";
import type { CodexOwnerSource } from "./services/sessions/codexRolloutOwner";
import { type BusySignal, resolveResumeBusyWindowMs } from "./services/sessions/conversationBusy";
import { IdempotencyStore } from "./services/sessions/idempotency";
import type { ReconcileVerdict } from "./services/sessions/reconcileSessions";
import { resumeIdForRow } from "./services/sessions/resumeIdentity";
import { SessionRegistryBoot } from "./session-registry-boot";
import { SessionStore } from "./session-store";
import { SessionWatchers } from "./session-watchers";
import type {
  AskQuestion,
  DiscoveredProcess,
  ManagedSession,
  PermissionOption,
  ServerConfig,
  ServerWarmingUpResponse,
  ServerWarmupState,
  SessionResponse,
} from "./types";

import { canonicalizeFilePath } from "./utils/canonicalizeFilePath";
import { toClientConversationLines } from "./utils/codexConversationLine";
import { parseIsoDateOrNull } from "./utils/dates";
import { createScanProgressThrottle } from "./utils/scanProgressThrottle";
import { WSHub } from "./ws-hub";

const DEFAULT_SYSTEM_PROMPT =
  "When presenting options or choices to the user, limit the options to at most 3.";

const DEFAULT_PTY_GRACE_PERIOD_MS = 270_000; // 4.5 minutes

// A `running` session is deferred (not held) so a mid-response turn is never
// interrupted. But a PTY that never settles back to waiting_input (e.g. its
// last line was a status bar with no prompt marker) would re-arm the grace
// timer forever and leak. Cap consecutive defers: after this many, hold anyway.
export const GRACE_MAX_DEFERS = 4;

// Idle reaper. Replaces "kill the PTY because nobody is subscribed" with "kill
// the PTY because the *agent* has done nothing for a long time" — a socket
// closing says nothing about whether work is in flight, but silence from the
// agent itself does. See docs/architecture/2026-07-24-durable-session-runtime.md.
//
// 6h is deliberately far above the old 4.5-minute grace period: the reaper is a
// resource backstop for abandoned sessions, not a session-lifetime policy. A
// session is only ever eligible while settled (waiting_input/idle) — a `running`
// PTY is never reaped no matter how long it has been running, because a long
// silent turn is exactly the work this runtime exists to protect.
export const IDLE_REAP_AFTER_MS = 6 * 60 * 60 * 1000;
// How often the sweep runs. Coarse on purpose — reaping 5 minutes late costs
// nothing, and a frequent timer on an idle server does not earn its wakeups.
export const IDLE_REAP_SWEEP_MS = 5 * 60 * 1000;

// A completed refreshFile within this window is treated as fresh — a retry
// storm on a live conversation collapses to one parse per window instead of
// one per request.

// How much of the tree a background conversation-list reconcile has to cover.

// Accepted `--model` / `/model` values: an alias ("opus", "sonnet") or a full
// model name ("claude-opus-4-5"). Deliberately strict — this string is written
// straight into a live PTY by applyLiveSessionSetting, so anything that could
// terminate the slash command (\r, \n) or start another word must be rejected
// rather than escaped.
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ─── Session lifecycle handlers ──────────────────────────────────────────────
// Same arrangement: the adopt kill-wait and the resume discovery bound live
// beside the handlers that use them, and are re-exported here because callers
// (and tests) import them from this module.
export {
  ADOPT_KILL_TIMEOUT_MS,
  RESUME_DISCOVERY_TIMEOUT_MS,
  waitForProcessExit,
} from "./api/handlers/sessions.handlers";
// ─── External (non-PTY) live tails ───────────────────────────────────────────
// Constants and behaviour live in ./external-tails with the manager that uses
// them; re-exported here because callers (and tests) import them from this
// module.
export {
  EXTERNAL_ACTIVE_WRITING_MS,
  EXTERNAL_TAIL_IDLE_MS,
  EXTERNAL_TAIL_MAX,
  EXTERNAL_TAIL_RECENCY_MS,
} from "./external-tails";

// Default OFF. Set to "1" or "true" to show Claude Agent SDK / claude-mem
// runs in /api/conversations and /project-chats.
export function parseIncludeAgentsEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off" || v === "");
}

/**
 * Why a resume did not happen, in the vocabulary of the thing that failed
 * rather than of HTTP (plan Phase 7c).
 *
 * `resumeSession` has two callers with nothing in common at the response layer:
 * one writes a status code, the other writes a log line. Neither can be the
 * owner of these distinctions, so they live here.
 */
export type ResumeFailure =
  | { ok: false; reason: "history_file_missing" }
  | { ok: false; reason: "no_project_path" }
  | {
      ok: false;
      reason: "conversation_busy";
      /** Which signals fired — carried verbatim so the 409 body is unchanged. */
      detectedBy: BusySignal[];
      lastActivityMs: number | null;
      likelyOwner: "external" | "unknown";
    }
  /**
   * Codex's own single-writer lock said no — either an open handle on the exact
   * rollout (pre-flight) or the `-32600` error Codex printed after spawn.
   *
   * Separate from `conversation_busy` because the two are not the same claim:
   * that one is a heuristic a caller may override with `force`, this one is the
   * provider refusing, which no flag of ours can bypass.
   */
  | {
      ok: false;
      reason: "codex_session_active";
      detectedBy: BusySignal[];
      lastActivityMs: number | null;
      ownerPid?: number;
      ownerSource?: CodexOwnerSource;
    }
  /** Codex exited or errored during startup for some other reason. */
  | { ok: false; reason: "codex_start_failed"; failureReason: string };

export type ResumeOutcome =
  | ResumeFailure
  | {
      ok: true;
      /** The session was already live here — nothing was spawned. */
      alreadyRunning: true;
      session: null;
      response: SessionResponse;
    }
  | {
      ok: true;
      alreadyRunning: false;
      session: ManagedSession;
      /** Null only if the store lost the session between spawn and read. */
      response: SessionResponse | null;
    };

export class StreamerServer {
  private httpServer: ReturnType<typeof createServer>;
  private ptyManager: LiveSessionManager;
  private sessionStore: SessionStore;
  private wsHub: WSHub;
  private fileWatcher: ConversationWatcher;
  private sessionFileMap = new Map<string, string>(); // sessionId → JSONL filePath
  // canonical JSONL path → live tail on a file NO PTY session owns (an external
  // agent is writing it). Deliberately separate from sessionFileMap so managed
  // session semantics — terminal_output, session_update, question cards — are
  // untouched: an external tail only ever pushes transcript lines.
  private externalTails = new Map<string, ExternalTailEntry>();
  // Drives the map above; the map itself stays a server field because it is
  // also read directly here (agent-file eviction, close()).
  private externalTailManager: ExternalTailManager;
  // Per-file seq assignments from the most recent onNewLineSpans (offset index),
  // handed to the immediately-following onNewLines so it can stamp WS `seq` on
  // the matching conversation_events entries. Same read → same lines order.
  private pendingLineSeqs = new Map<string, (number | null)[]>();
  // `origin` records whether the pending question came from the live PTY-screen
  // path (handleLiveQuestion) or a JSONL flush. A JSONL-derived question must
  // never clobber a PTY-originated one for a DIFFERENT question — an external
  // agent appending an AskUserQuestion into a shared conversation would
  // otherwise misroute the answer into this streamer's PTY.
  private pendingQuestions = new Map<
    string,
    { toolUseId: string; questions: AskQuestion[]; origin: "pty" | "jsonl" }
  >();
  // Sessions resumed past a detected collision (busy probe said busy, caller
  // forced). JSONL-derived actionable question cards are suppressed for these
  // because a line in the shared file may have been written by the other owner.
  private contendedSessions = new Set<string>();
  // conversationId → ms epoch when THIS streamer's PTY for it last went idle.
  // Lets the resume collision probe tell our own trailing JSONL writes (a
  // hold → resume round trip) apart from another owner's. Pruned on write so it
  // cannot grow without bound across a long-lived process.
  private selfPtyEndedAt = new Map<string, number>();
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
  // Content key (prompt + detail + options + cursor) of the permission gate
  // currently broadcast for a session — mirrors pendingQuestionKey so a PTY
  // repaint of the same gate doesn't re-broadcast on every tick. Cleared
  // alongside pendingPermission.
  private pendingPermissionKey = new Map<string, string>();
  // Scanner lifecycle, freshness state and the cache↔disk reconcile.
  private scannerManager: ScannerManager;
  // Binds a live session to the JSONL/rollout its provider writes.
  private sessionWatchers: SessionWatchers;
  // Boot/shutdown lifecycle of the durable session registry.
  private registryBoot: SessionRegistryBoot;
  // Conversation list/count/detail/search reads and the JSONL/cwd resolvers.
  private conversationHandlers: ConversationHandlers;
  // Session list/get/start/resume/fork/adopt/input/answer/upload/stop handlers.
  private sessionHandlers: SessionHandlers;
  // True only while bindWithRetry is actively retrying. The persistent
  // listener-level 'error' handler demotes EADDRINUSE to debug during this
  // window so the self-healing kickstart-relaunch race doesn't spam warn.
  private binding = false;
  private activeWarmups = new Map<number, ServerWarmupState>([[0, "startup"]]);
  private nextWarmupId = 1;
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
  // Skip the startup warm-up scan (test hook; see ServerConfig.skipStartupWarmup).
  private skipStartupWarmup: boolean;
  private autoResumeOnBoot: boolean;
  private browseRoot: string | null = null;
  private publicUrl: string | null = null;
  private browserCors: string | undefined;
  private pairTokens = new PairTokenStore();
  private exchangeAttempts = new Map<string, number[]>();
  private sessionStartAttempts = new Map<string, number[]>();
  private sessionInputAttempts = new Map<string, number[]>();
  private ptyGracePeriodMs: number;
  private defaultSystemPrompt: string;
  // Resolved once at boot; see src/feature-flags.ts. Total map — every registry
  // id is present, so indexing it never yields undefined.
  private featureFlags: FeatureFlagValues;
  // Derived from featureFlags.codexSystemPrompt. Kept as its own field so the
  // read site in startFresh() is unchanged.
  private codexSystemPromptEnabled: boolean;
  private defaultPermissionMode: PermissionMode;
  private defaultModel: string;
  private defaultEffort: EffortLevel;
  // Allowlisted Claude CLI flags + free-text escape hatch, applied to every
  // spawn. Resolved once at startup (flag → server.yaml), then mutated in place
  // by PUT /api/config/claude-flags so a change applies to the next session
  // without a restart.
  private claudeFlags: ClaudeFlagValues;
  private claudeExtraArgs: string | undefined;
  // True when the values came from server.yaml (and so a write persists).
  // False when they were pinned by a CLI flag, mirroring the api-key rotate
  // contract: the write still takes effect in memory but won't survive restart.
  private claudeFlagsPersistable: boolean;
  // Map of sessionId → grace timer; fires to kill PTY after WS disconnect
  private ptyGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Consecutive grace-timer defers for a still-`running` session (see
  // GRACE_MAX_DEFERS). Reset when a subscriber reconnects or the PTY settles.
  private ptyGraceDeferCounts = new Map<string, number>();
  // Map of sessionId → set of subscribed WS clients
  private sessionSubscribers = new Map<string, Set<WebSocket>>();
  // sessionId → wall-clock ms of the last PTY chunk. Written from onOutput for
  // every provider; read only by the idle reaper. Entries are dropped when the
  // session leaves the runner (reap/exit/hold).
  private lastAgentChunkAt = new Map<string, number>();
  // sessionId → last terminal_output seq broadcast (starts at 1, per session).
  // Stamped on every terminal_output/terminal_replay so a client can detect a
  // stale chunk delivered after a reconnect race instead of trusting raw WS
  // arrival order. Entries dropped alongside lastAgentChunkAt.
  private terminalSeq = new Map<string, number>();
  // Recently accepted input idempotency keys (C4). A retried POST replays its
  // original outcome instead of submitting the prompt to the agent twice.
  private idempotency = new IdempotencyStore();
  // sessionId → lifecycle verdict from boot reconciliation. Only holds sessions
  // this run did NOT spawn; live ones derive their lifecycle from ptyAttached.
  private sessionVerdicts = new Map<string, ReconcileVerdict>();
  // Periodic sweep that releases PTYs no agent is using. Null until listen().
  private idleReaperTimer: ReturnType<typeof setInterval> | null = null;
  // Map of clientId → WS socket (populated by the "register" WS handshake)
  private clientIdToWs = new Map<string, WebSocket>();
  // Reverse map for cleanup on close
  private wsToClientId = new Map<WebSocket, string>();
  private cache: ConversationCache | null = null;
  private cacheMonitor: CacheIntegrityMonitor | null = null;
  private projectsRepo: ProjectsRepository | null = null;
  private conversationsRepo: ConversationsRepository | null = null;
  private sessionsRepo: SessionsRepository | null = null;
  // Durable session registry (C1 Phase 2). Null when runtime.db failed to open
  // — persistence degrades to today's in-memory-only behaviour rather than
  // taking the server down with it, so every write goes through `?.`. Note the
  // handle is runtime.db, NOT the conversation cache: a cache failure used to
  // null this repo and silently disable all session persistence.
  private managedSessionsRepo: ManagedSessionsRepository | null = null;
  private runtimeStore: RuntimeStore | null = null;
  // Identifies this streamer run. A registry row carrying a different id is a
  // session that outlived the process that started it.
  private readonly streamerInstanceId = randomUUID();
  private cacheMetadataRepo: CacheMetadataRepository | null = null;
  // Push registration + delivery state (C7). Null when the cache DB failed to
  // open — registration then degrades to a no-op rather than 500ing.
  private pushRepo: PushRepository | null = null;

  // Paired-device registry (C5). Null when the cache DB failed to open — auth
  // then falls back to the shared API key alone, which is the pre-C5 behaviour.
  private devicesRepo: DevicesRepository | null = null;
  // Live Activity push (Feature 12). Null when APNS_KEY is unset — the ordinary
  // case on a dev machine and in CI, where the feature is simply off. Missing an
  // optional push credential must never stop the server from booting.
  private apnsClient: ApnsClient | null = null;
  private liveActivityNotifier: LiveActivityNotifier | null = null;
  private liveActivityRenewal: LiveActivityRenewalScheduler | null = null;
  // "Your turn" notifications over Expo's relay (#528). Needs no credential of
  // its own, so unlike the Live Activity path it is on wherever the cache DB
  // opened — with no registered device it simply sends nothing.
  private waitingInputNotifier: WaitingInputNotifier | null = null;
  private discoveryCache: {
    entries: DiscoveredProcess[];
    fetchedAt: number;
  } | null = null;
  // Single-flight for process discovery. Mobile polls GET /api/sessions and
  // retries on timeout; without this, every concurrent request starts its own
  // Windows CIM scan (observed: overlapping 80–100s /api/sessions responses).
  private discoveryInFlight: Promise<DiscoveredProcess[]> | null = null;
  private cacheDir: string;
  private runtimeDbPath: string;
  private tailSize: number;
  private directoryDebounceMs: number;
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
    this.skipStartupWarmup = config.skipStartupWarmup ?? false;
    this.autoResumeOnBoot = config.autoResumeOnBoot ?? false;
    this.scanProfiles = config.scanProfiles;
    this.codexRoots = config.codexRoots ?? [join(homedir(), ".codex", "sessions")];
    this.ptyGracePeriodMs = config.ptyGracePeriodMs ?? DEFAULT_PTY_GRACE_PERIOD_MS;
    this.defaultSystemPrompt = config.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    // env > CLI > server.yaml > registry default, then the legacy explicit
    // field on top (see ServerConfig.codexSystemPromptEnabled).
    this.featureFlags = resolveFeatureFlags({ cli: config.featureFlags, yaml: loadFeatureFlags() });
    if (config.codexSystemPromptEnabled !== undefined) {
      this.featureFlags.codexSystemPrompt = config.codexSystemPromptEnabled;
    }
    this.codexSystemPromptEnabled = this.featureFlags.codexSystemPrompt;
    this.defaultPermissionMode =
      config.defaultPermissionMode ?? loadDefaultPermissionMode() ?? "acceptEdits";
    this.defaultModel = config.defaultModel ?? "sonnet";
    this.defaultEffort = config.defaultEffort ?? "low";
    this.claudeFlagsPersistable = config.claudeFlags === undefined;
    this.claudeFlags = config.claudeFlags ?? loadClaudeFlags();
    this.claudeExtraArgs = config.claudeExtraArgs ?? loadClaudeExtraArgs();
    this.cacheDir = config.cacheDir ?? loadCacheDir() ?? join(homedir(), ".threadbase", "cache");
    // Sibling of server.yaml, deliberately NOT under cache/ — see runtime-store.ts.
    this.runtimeDbPath =
      config.runtimeDbPath ??
      process.env.THREADBASE_RUNTIME_DB ??
      join(process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase"), "runtime.db");
    this.tailSize = config.tailSize ?? loadTailSize() ?? 10;
    this.directoryDebounceMs =
      parseDirScanDebounceEnv(process.env.THREADBASE_DIR_SCAN_DEBOUNCE_MS) ??
      config.directoryScanDebounceMs ??
      1000;
    this.scannerManager = new ScannerManager({
      scanProfiles: this.scanProfiles,
      codexRoots: this.codexRoots,
      directoryDebounceMs: this.directoryDebounceMs,
      persistenceDisabled: config.scannerPersistent === false,
      // Thunks, not values: these are opened during listen() and rebound by
      // the integrity monitor's reset-and-rescan.
      cache: () => this.cache,
      cacheMonitor: () => this.cacheMonitor,
      projectsRepo: () => this.projectsRepo,
      conversationsRepo: () => this.conversationsRepo,
      cacheMetadataRepo: () => this.cacheMetadataRepo,
      trackCacheWrite: (task) => this.trackCacheWrite(task),
    });
    this.registryBoot = new SessionRegistryBoot({
      // Thunks for the same reason ScannerManager takes them: the registry repo
      // is opened during listen(), and `log`/`resumeSession` are swapped on the
      // server instance by tests.
      log: () => this.log,
      ptyManager: () => this.ptyManager,
      sessionStore: () => this.sessionStore,
      featureFlags: () => this.featureFlags,
      autoResumeOnBoot: () => this.autoResumeOnBoot,
      managedSessionsRepo: () => this.managedSessionsRepo,
      streamerInstanceId: this.streamerInstanceId,
      sessionVerdicts: this.sessionVerdicts,
      selfPtyEndedAt: this.selfPtyEndedAt,
      resumeSession: (opts) => this.sessionHandlers.resumeSession(opts),
      watchConversationFile: (sessionId, historyId) =>
        this.sessionWatchers.watchConversationFile(sessionId, historyId),
      broadcastSessionList: () => this.wsHub.broadcast(this.sessionListPayload()),
    });
    this.includeAgents = parseIncludeAgentsEnv(process.env.THREADBASE_INCLUDE_AGENTS);
    this.agentEntrypoints = parseAgentEntrypointsEnv(process.env.THREADBASE_AGENT_ENTRYPOINTS);

    // Log only what differs from the registry defaults: on a normal boot this is
    // silent, so a line here always means someone turned something on.
    const enabledFlags = nonDefaultFeatureFlags(this.featureFlags);
    if (enabledFlags.length > 0) {
      this.log.info(`Feature flags active: ${enabledFlags.join(", ")}`, {
        event: "config.feature_flags_active",
        flags: enabledFlags,
      });
    }

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
        let managed = false;
        for (const [sessionId, watchedPath] of this.sessionFileMap) {
          if (watchedPath === filePath) {
            managed = true;
            this.processJsonlQuestions(sessionId, lines);
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
        // No PTY owns this file: it's an external tail (or nothing at all, in
        // which case the call is a no-op). Transcript push only — never the
        // managed-session events, and never a question card.
        if (!managed) {
          this.externalTailManager.broadcastExternalTailLines(
            filePath,
            lines,
            this.pendingLineSeqs.get(filePath),
          );
        }
        // Seqs are consumed for this read; drop them so a later read for a file
        // with no watched session can't reuse a stale mapping.
        this.pendingLineSeqs.delete(filePath);
      },
      onConversationChanged: (filePath) => {
        // Directory unlink is the survivor when the per-file watcher's unlink
        // is dropped (delete inside a write-finish window, or a dead handle).
        // Detect gone-on-disk here and take the same detach + invalidate path
        // as onFileDeleted — otherwise an external tail stays attached until
        // the 5 min idle sweep (#393).
        try {
          statSync(filePath);
        } catch {
          this.externalTailManager.handleJsonlDeleted(filePath);
          return;
        }
        // A new JSONL appeared (or changed) in a watched project directory.
        // If we hold a per-file tail for it, re-drive the tail read from here
        // too: per-file fs.watch handles can die silently (2026-07-01 incident
        // — tails went permanently quiet while directory events kept flowing),
        // and the directory watcher is the survivor that can heal them.
        const tailed = this.fileWatcher.poke(filePath);
        // Nobody is tailing it yet — if an external agent is actively writing
        // it, attach a tail so its transcript is pushed instead of silently
        // waiting for the client to poll.
        if (!tailed) this.externalTailManager.maybeAttachExternalTail(filePath);
        this.externalTailManager.sweepIdleExternalTails();
        // Upsert-or-leave: a change event NEVER deletes the cache row (skipIfTailed).
        // This same append also drives the live-tail watcher's updateFromLines
        // upsert; the two fire with no ordering guarantee, so deleting here would
        // wipe a row the live tail just wrote (CRITICAL #2) — and a refresh-created
        // untailed row would vanish on its next append. The debounced rescan below
        // re-derives metadata, so leaving the row loses nothing.
        this.cache?.invalidateByFilePath(filePath, { skipIfTailed: true });
        // Debounce the scanner-staleness flip so a burst of directory events
        // during active sessions collapses into one reconcile trigger after a
        // quiet period. The debounced callback still checks scannerReady at
        // fire time, preserving the anti-infinite-loop rule (never null
        // scannerReady mid-scan). Record the path before debouncing so the
        // reconcile can refresh exactly this file instead of the whole tree.
        this.scannerManager.staleFiles.add(filePath);
        this.scannerManager.markStaleDebounced();
        this.log.debug?.(`Scanner invalidated by directory event: ${filePath}`, {
          filePath,
          event: "cache.directory_change",
        });
      },
      onTruncated: (filePath) => {
        // The file shrank below our offset — it is a different generation of
        // content now, so every byte span we recorded for it is meaningless.
        // Drop the index (and its parse state); the next read rebuilds from 0.
        this.cache?.deleteFileIndex(filePath, ConversationCache.conversationIdForFile(filePath));
        this.cache?.clearIndexParseState(filePath);
        this.log.warn(`JSONL truncated/replaced; offset index dropped: ${filePath}`, {
          filePath,
          event: "tail.truncated",
        });
      },
      onFileDeleted: (filePath) => this.externalTailManager.handleJsonlDeleted(filePath),
      onError: (filePath, err) => {
        // Was unwired, so every watcher error was dropped on the floor. The one
        // that matters is ENOSPC from a directory watch: chokidar takes one
        // OS-level watch handle PER FILE under a watched root (see
        // watchDirectory's note), so on Linux the conversation corpus is spent
        // directly against inotify's per-user max_user_watches — a ceiling as
        // low as 8192 on some distros, shared with every other watcher the user
        // is running. Past it the watch never attaches: tails go quiet and new
        // conversations stop being discovered, with nothing in the log tying it
        // to the fd budget. Name the cause here so it isn't re-derived.
        const enospc = (err as NodeJS.ErrnoException).code === "ENOSPC";
        this.log.error(
          enospc
            ? `Watcher hit the OS watch-handle limit on ${filePath} — raise fs.inotify.max_user_watches (Linux) or the process fd limit; conversation discovery and live tails are degraded until then`
            : `Watcher error on ${filePath}: ${err.message}`,
          { filePath, err, event: enospc ? "watcher.limit_exhausted" : "watcher.error" },
        );
      },
    });

    this.externalTailManager = new ExternalTailManager({
      tails: this.externalTails,
      sessionFileMap: this.sessionFileMap,
      fileWatcher: this.fileWatcher,
      wsHub: this.wsHub,
      // Thunks, not values: these are opened during listen() and rebound by
      // the integrity monitor's reset-and-rescan.
      cache: () => this.cache,
      cacheMonitor: () => this.cacheMonitor,
      broadcastConversationLines: (sessionId, lines, seqs) =>
        this.broadcastConversationLines(sessionId, lines, seqs),
    });

    this.ptyManager = new LiveSessionManager({
      logger: getLogger("pty"),
      onOutput: (sessionId, data) => {
        // Agent-activity stamp for the idle reaper. Fires for every provider
        // (both runners call onOutput), so the reaper needs no per-runner
        // bookkeeping. Distinct from ManagedSession.lastActivityAt, which only
        // moves on *user* input — an agent grinding through a long task is
        // active even when nobody has touched it.
        this.lastAgentChunkAt.set(sessionId, Date.now());
        const seq = (this.terminalSeq.get(sessionId) ?? 0) + 1;
        this.terminalSeq.set(sessionId, seq);
        this.wsHub.broadcastToClients(this.sessionSubscribers.get(sessionId) ?? [], {
          type: "terminal_output",
          sessionId,
          data,
          seq,
        });
      },
      onUserMessage: (sessionId, text, ts) => {
        this.wsHub.broadcastToClients(this.sessionSubscribers.get(sessionId) ?? [], {
          type: "user_message",
          sessionId,
          text,
          ts,
        });
      },
      onPermissionChange: (sessionId, gate) => {
        this.sessionHandlers.handlePermissionChange(sessionId, gate);
      },
      onLiveQuestion: (sessionId, questions) => {
        this.sessionHandlers.handleLiveQuestion(sessionId, questions);
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
        // Captured before the update below overwrites it — the Live Activity
        // notifier needs the pre-transition status to tell a genuine
        // waiting_input↔running edge apart from a same-status re-emit.
        const previousStatus = this.sessionStore.getManaged(session.id)?.status;
        this.sessionStore.updateManaged(session.id, {
          status: session.status,
          completedAt: session.completedAt,
          ...(session.lastActivityAt != null && { lastActivityAt: session.lastActivityAt }),
          // The runner derives this from the first user message, on its own
          // copy of the session. Without mirroring it here SessionStore never
          // learns it, so a fresh live session is served with no sessionName
          // even though the registry has one — the name only appeared after a
          // restart rebuilt the row as a stub. Guarded so a runner that has not
          // derived one yet cannot blank a name set by enrichResumedSessionAsync.
          ...(session.sessionName != null && { sessionName: session.sessionName }),
          // Without mirroring this, SessionStore's copy is frozen at whatever
          // `addManaged` saw at spawn ("spawn") forever, because updateManaged
          // is a partial merge — so managedToResponse can never tell a
          // grace-timer/idle-reaper hold (statusSource "shutdown") apart from a
          // genuine process exit ("process-exit"), and reports both as
          // `lifecycle: "completed"`. See managedToResponse in session-store.ts.
          ...(session.statusSource != null && { statusSource: session.statusSource }),
        });
        // Mirror the transition into the durable registry. Both runners funnel
        // every status change through this callback, so this is the one place
        // that needs to know. `exit` vs `transition` is the distinction the
        // reconciler cares about: a row with a recorded exit needs no probe.
        this.managedSessionsRepo?.recordStatus(
          session.id,
          session.status,
          session.completedAt != null ? "exit" : "transition",
          {
            completedAt: session.completedAt,
            lastActivityAt: session.lastActivityAt ?? null,
            promptCount: session.promptCount,
            failureReason: session.failureReason ?? null,
            // Derived from the first user message, so it does not exist yet at
            // recordSpawn. The input that produces it also flips
            // waiting_input→running, which lands here.
            sessionName: session.sessionName ?? null,
          },
        );
        // Refresh the scanner index at the end of each Claude turn so the
        // conversation is searchable with up-to-date content immediately.
        if (session.status === "waiting_input" || session.status === "idle") {
          const filePath = this.sessionFileMap.get(session.id);
          if (filePath) {
            this.scannerManager
              .get()
              .then((scanner) => this.scannerManager.refreshFileGuarded(scanner, filePath))
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
          this.pendingPermissionKey.delete(session.id);
          this.contendedSessions.delete(session.id);
          // Remember that WE owned this conversation up to now, so a resume that
          // follows a hold isn't mistaken for a collision with someone else
          // (see conversationBusy's selfPtyEndedAt).
          this.rememberSelfPtyEnded(session.id);
        }
        const resp = this.sessionStore.get(session.id, this.ptyAttachedIds());
        if (resp) {
          this.wsHub.broadcast({ type: "session_update", session: resp });
        }
        // Push the transition to any iOS Live Activity watching this session.
        // Fire-and-forget: the notifier logs its own failures, and a push must
        // never delay or fail a session transition. No-op when APNs is off.
        void this.liveActivityNotifier?.onStatusChange(session, previousStatus);
        // And tell the phone its turn is up, if nobody is watching this session
        // already. Same funnel, same fire-and-forget contract as above.
        void this.waitingInputNotifier?.onStatusChange(session, previousStatus);
        // The session object rides along: SessionStore's copy is a partial
        // merge that does not carry failureReason/failureCode, so a startup
        // handshake reading the store could not tell WHY a session went idle.
        this.sessionStatusBus.emit(`status:${session.id}`, session.status, session);
      },
    });

    this.sessionWatchers = new SessionWatchers({
      ptyManager: this.ptyManager,
      sessionStore: this.sessionStore,
      wsHub: this.wsHub,
      fileWatcher: this.fileWatcher,
      sessionFileMap: this.sessionFileMap,
      scannerManager: this.scannerManager,
      codexRoots: this.codexRoots,
      // Thunks, not values: these are opened during listen() and rebound by
      // the integrity monitor's reset-and-rescan.
      cache: () => this.cache,
      projectsRepo: () => this.projectsRepo,
      conversationsRepo: () => this.conversationsRepo,
      sessionsRepo: () => this.sessionsRepo,
      cacheMetadataRepo: () => this.cacheMetadataRepo,
      managedSessionsRepo: () => this.managedSessionsRepo,
      findConversationByUuid: (uuid) => this.conversationHandlers.findConversationByUuid(uuid),
      broadcastConversationLines: (sessionId, lines) =>
        this.broadcastConversationLines(sessionId, lines),
      ptyAttachedIds: () => this.ptyAttachedIds(),
    });

    this.conversationHandlers = new ConversationHandlers({
      scannerManager: this.scannerManager,
      sessionStore: this.sessionStore,
      ptyManager: this.ptyManager,
      wsHub: this.wsHub,
      scanProfiles: this.scanProfiles,
      // Thunks for the same reason the managers above take them: the cache is
      // opened during listen() and rebound by the integrity monitor's
      // reset-and-rescan, and tests swap `log` on the server instance.
      cache: () => this.cache,
      log: () => this.log,
      rejectIfWarmingUp: (res) => this.rejectIfWarmingUp(res),
      withWarmup: (state, operation) => this.withWarmup(state, operation),
      trackCacheWrite: (task) => this.trackCacheWrite(task),
      resolveConversationLookupId: (uuid) => this.resolveConversationLookupId(uuid),
      findLiveSessionFilePath: (uuid) => this.findLiveSessionFilePath(uuid),
      isBoundConversationLive: (boundId) => this.isBoundConversationLive(boundId),
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

    this.sessionHandlers = new SessionHandlers({
      // Collaborators the constructor already built. The Maps and Sets are
      // passed by reference on purpose: they stay StreamerServer state, and a
      // mutation from a handler is the same mutation the WS/PTY callbacks here
      // — and the tests that reach in via `(server as any)` — observe.
      sessionStore: this.sessionStore,
      ptyManager: this.ptyManager,
      wsHub: this.wsHub,
      scannerManager: this.scannerManager,
      sessionWatchers: this.sessionWatchers,
      registryBoot: this.registryBoot,
      externalTailManager: this.externalTailManager,
      idempotency: this.idempotency,
      sessionStatusBus: this.sessionStatusBus,
      sessionFileMap: this.sessionFileMap,
      pendingQuestions: this.pendingQuestions,
      pendingQuestionKey: this.pendingQuestionKey,
      pendingPermission: this.pendingPermission,
      pendingPermissionKey: this.pendingPermissionKey,
      contendedSessions: this.contendedSessions,
      selfPtyEndedAt: this.selfPtyEndedAt,
      sessionSubscribers: this.sessionSubscribers,
      agentConfig: this.agentConfig,
      agentClient: this.agentClient,
      defaultSystemPrompt: this.defaultSystemPrompt,
      codexSystemPromptEnabled: this.codexSystemPromptEnabled,
      cacheDir: this.cacheDir,
      // Thunks for the same reason ConversationHandlers takes them: bound after
      // construction (cache, dbPool, browseRoot), mutated at runtime by
      // PUT /api/config/claude-flags, or swapped on the instance by tests.
      cache: () => this.cache,
      log: () => this.log,
      browseRoot: () => this.browseRoot,
      claudeFlags: () => this.claudeFlags,
      claudeExtraArgs: () => this.claudeExtraArgs,
      dbPool: () => this.dbPool,
      dbInstanceId: () => this.dbInstanceId,
      discoveryCache: () => this.discoveryCache,
      setDiscoveryCache: (value) => {
        this.discoveryCache = value;
      },
      discoveryInFlight: () => this.discoveryInFlight,
      setDiscoveryInFlight: (value) => {
        this.discoveryInFlight = value;
      },
      rejectIfWarmingUp: (res) => this.rejectIfWarmingUp(res),
      ptyAttachedIds: () => this.ptyAttachedIds(),
      withReconciledLifecycle: (sessions) => this.withReconciledLifecycle(sessions),
      broadcastOrUnicastSessionList: (req) => this.broadcastOrUnicastSessionList(req),
      checkSessionStartRateLimit: (ip) => this.checkSessionStartRateLimit(ip),
      checkSessionInputRateLimit: (sessionId) => this.checkSessionInputRateLimit(sessionId),
      spawnFlagOverrides: () => this.spawnFlagOverrides(),
      resolveConversationTarget: (sessionId) => this.resolveConversationTarget(sessionId),
      waitForStartupOutcome: (sessionId, timeoutMs) =>
        this.waitForStartupOutcome(sessionId, timeoutMs),
      abandonFailedStart: (sessionId) => this.abandonFailedStart(sessionId),
      enrichResumedSessionAsync: (sessionId, projectPath, conv) =>
        this.enrichResumedSessionAsync(sessionId, projectPath, conv),
      findJsonlPath: (uuid) => this.conversationHandlers.findJsonlPath(uuid),
      readCwdFromJsonl: (filePath) => this.conversationHandlers.readCwdFromJsonl(filePath),
    });

    const self = this;
    const apiDeps: ApiDeps = {
      // ponytail: getter so rotateApiKey() takes effect without restarting the server
      get apiKey() {
        return self.apiKey;
      },
      localNoAuth: this.localNoAuth,
      logMenubarRequests: this.logMenubarRequests,
      rotateApiKey: () => this.rotateApiKey(),
      claudeFlagsConfig: () => this.getClaudeFlagsConfig(),
      featureFlagsConfig: () => this.getFeatureFlagsConfig(),
      setClaudeFlagsConfig: (values, extraArgs) => this.setClaudeFlagsConfig(values, extraArgs),
      publicUrl: this.publicUrl,
      browseRoot: this.browseRoot,
      browserCors: this.browserCors,
      ptyManager: this.ptyManager,
      sessionStore: this.sessionStore,
      wsHub: this.wsHub,
      cache: () => this.cache,
      cacheMonitor: () => this.cacheMonitor,
      pushRepo: () => this.pushRepo,
      liveActivityPushEnabled: () => this.liveActivityNotifier !== null,

      devicesRepo: () => this.devicesRepo,
      projectsRepo: () => this.projectsRepo,
      conversationsRepo: () => this.conversationsRepo,
      sessionsRepo: () => this.sessionsRepo,
      cacheMetadataRepo: () => this.cacheMetadataRepo,
      runtimeStore: () => this.runtimeStore,
      managedSessionsRepo: () => this.managedSessionsRepo,
      sessionVerdicts: () => this.sessionVerdicts,
      ptyAttachedIds: () => this.ptyAttachedIds(),
      handleListSessions: (url, res) => this.sessionHandlers.handleListSessions(url, res),
      handleSessionsCount: (res) => this.handleSessionsCount(res),
      handleGetRecentSessions: (url, res) =>
        this.conversationHandlers.handleGetRecentSessions(url, res),
      handleGetSessionNames: (res) => this.sessionHandlers.handleGetSessionNames(res),
      handleGetSession: (id, res) => this.sessionHandlers.handleGetSession(id, res),
      handleGetOutput: (id, res) => this.sessionHandlers.handleGetOutput(id, res),
      handleSendInput: (id, req, res) => this.sessionHandlers.handleSendInput(id, req, res),
      handleSendAnswer: (id, req, res) => this.sessionHandlers.handleSendAnswer(id, req, res),
      handleCancel: (id, res) => this.sessionHandlers.handleCancel(id, res),
      handleStopSession: (id, res) => this.sessionHandlers.handleStopSession(id, res),
      handleSetSessionName: (id, req, res) =>
        this.sessionHandlers.handleSetSessionName(id, req, res),
      handleSetSessionModel: (id, req, res) => this.applyLiveSessionSetting(id, req, res, "model"),
      handleSetSessionEffort: (id, req, res) =>
        this.applyLiveSessionSetting(id, req, res, "effort"),
      handleUploadFile: (id, req, res) => this.sessionHandlers.handleUploadFile(id, req, res),
      handleAdopt: (id, res) => this.sessionHandlers.handleAdopt(id, res),
      handleFork: (id, req, res) => this.sessionHandlers.handleFork(id, req, res),
      handleResume: (req, res) => this.sessionHandlers.handleResume(req, res),
      handleStartSession: (req, res) => this.sessionHandlers.handleStartSession(req, res),
      handleListConversations: (url, res) =>
        this.conversationHandlers.handleListConversations(url, res),
      handleConversationsCount: (url, res) =>
        this.conversationHandlers.handleConversationsCount(url, res),
      handleGetConversation: (id, url, res, ifNoneMatch) =>
        this.conversationHandlers.handleGetConversation(id, url, res, ifNoneMatch),
      handleSearch: (url, res) => this.conversationHandlers.handleSearch(url, res),
      handleSearchTarget: (id, req, res) =>
        this.conversationHandlers.handleSearchTarget(id, req, res),
      handleListProjects: (url, res) => handleListProjects(url, res),
      handleGetPopularProjects: (url, res) =>
        this.conversationHandlers.handleGetPopularProjects(url, res),
      handleGetProjectSummaries: (url, res) =>
        this.conversationHandlers.handleGetProjectSummaries(url, res),
      handlePairStart: (res) => this.handlePairStart(res),
      handlePairExchange: (req, res) => this.handlePairExchange(req, res),
      handleBrowse: (url, res) => this.handleBrowse(url, res),
      handleMkdir: (req, res) => this.handleMkdir(req, res),
      handleWsOpen: (ws) => {
        this.wsHub.addClient(ws);
        const sessions = this.withReconciledLifecycle(
          this.sessionStore.list(this.ptyAttachedIds()),
        );
        ws.send(JSON.stringify({ type: "session_list", sessions }));
        if (!this.currentWarmupState()) {
          ws.send(JSON.stringify({ type: "cache_ready" }));
        }
        // Re-surface a pending cache-integrity alert to every connecting client
        // (covers the startup warm-up window and every reconnect).
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
                  seq: this.terminalSeq.get(msg.sessionId),
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
            this.startGraceTimer(msg.sessionId, this.ptyGracePeriodMs);
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
        for (const subscribers of this.sessionSubscribers.values()) {
          subscribers.delete(ws);
          // Deliberately does NOT arm a kill timer. A socket closing is not a
          // request to stop the agent: phones sleep, signal drops, Wi-Fi hands
          // off to cellular. Killing the PTY because nobody is watching means a
          // long agent task cannot outlive a backgrounded app — the failure this
          // runtime exists to prevent (see
          // docs/architecture/2026-07-24-durable-session-runtime.md).
          //
          // Unbounded PTY growth is bounded by the idle reaper instead, which
          // measures agent inactivity rather than subscriber absence. An
          // explicit hold_session from the client still terminates immediately
          // (see the hold_session handler above) — that one IS a user intent.
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

  // Record that our own PTY for `conversationId` just ended. Entries older than
  // the busy window can never change a verdict, so drop them as we go rather
  // than accumulating one per conversation for the process's lifetime.
  private rememberSelfPtyEnded(conversationId: string): void {
    const now = Date.now();
    const cutoff = now - resolveResumeBusyWindowMs();
    for (const [id, at] of this.selfPtyEndedAt) {
      if (at < cutoff) this.selfPtyEndedAt.delete(id);
    }
    this.selfPtyEndedAt.set(conversationId, now);
  }

  /**
   * Send a session_list to only the client that triggered this HTTP request
   * (identified by X-Client-Id header → registered WS socket). Falls back to
   * a full broadcast if no match exists (old clients, or no WS registered yet).
   */
  private broadcastOrUnicastSessionList(req: IncomingMessage): void {
    const clientId = req.headers["x-client-id"];
    const ws = typeof clientId === "string" ? this.clientIdToWs.get(clientId) : undefined;
    const payload = this.sessionListPayload();
    if (ws) {
      this.wsHub.unicast(ws, payload);
    } else {
      this.wsHub.broadcast(payload);
    }
  }

  private sessionListPayload(): { type: "session_list"; sessions: readonly SessionResponse[] } {
    return {
      type: "session_list" as const,
      sessions: this.withReconciledLifecycle(this.sessionStore.list(this.ptyAttachedIds())),
    };
  }

  /**
   * Overlay boot-reconciliation verdicts onto session responses.
   *
   * A session left by a previous run is not in the in-memory store, so
   * SessionStore cannot classify it — it only ever sees what this run spawned.
   * Discovery may still surface the process, in which case the reconciler knows
   * strictly more about it than discovery does: it can tell `detached` (alive
   * and confirmed ours) from `orphaned` (alive but identity unconfirmed), which
   * a pid enumeration alone cannot.
   *
   * Only applied when the session is NOT live here: a session this run owns has
   * an authoritative lifecycle already, and a stale verdict must never override
   * it.
   */
  private withReconciledLifecycle(
    sessions: readonly SessionResponse[],
  ): readonly SessionResponse[] {
    if (this.sessionVerdicts.size === 0) return sessions;
    return sessions.map((s) => {
      if (s.ptyAttached) return s;
      const verdict = this.sessionVerdicts.get(s.id);
      if (!verdict) return s;
      return { ...s, lifecycle: verdict.lifecycle, lifecycleSource: "reconcile" as const };
    });
  }

  private addSessionSubscriber(sessionId: string, ws: WebSocket): void {
    let subs = this.sessionSubscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.sessionSubscribers.set(sessionId, subs);
    }
    subs.add(ws);
    // Cancel any pending grace timer since someone is now watching. Reset the
    // defer count too so the next disconnect starts a fresh defer budget.
    const existing = this.ptyGraceTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.ptyGraceTimers.delete(sessionId);
    }
    this.ptyGraceDeferCounts.delete(sessionId);
  }

  /**
   * Bring up Live Activity push, if credentials are present (Feature 12).
   *
   * APNS_KEY absent is the ordinary case on a dev machine and in CI, so this
   * logs once at info and leaves the feature off rather than failing: the server
   * must not refuse to boot over a missing optional push credential.
   *
   * The key is read from the environment as PEM contents and never from a path
   * on disk; neither it nor any device token is ever logged.
   */
  private initLiveActivityPush(pushRepo: PushRepository): void {
    // Logged rather than returned silently: a box with APNS_KEY configured used
    // to print "Live Activity push enabled" here, so an operator who flips the
    // flag off needs the credential to look ignored on purpose, not missing.
    if (!this.featureFlags.liveActivityPush) {
      this.log.info(
        "Live Activity push is disabled by the liveActivityPush feature flag. " +
          "Enable it with THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH=1, --feature liveActivityPush=true, " +
          "or feature_flags: in server.yaml.",
        { event: "live_activity.disabled" },
      );
      return;
    }

    const creds = readApnsCredentialsFromEnv();
    if (!creds) {
      const why = describeMissingApnsCredentials();
      if (why) this.log.info(why, { event: "live_activity.disabled" });
      return;
    }

    this.apnsClient = new ApnsClient(creds);
    const sender = new LiveActivitySender(this.apnsClient, pushRepo);
    // Identifies this streamer to mobile, which shows several servers at once.
    // Matches the id used for DB-persisted session scoping.
    const serverId = process.env.THREADBASE_INSTANCE_ID ?? hostname();
    this.liveActivityNotifier = new LiveActivityNotifier(sender, serverId, hostname());
    // Re-arms pending renewals from the DB. Started here rather than lazily
    // because the deadlines were persisted precisely so a restart inside an
    // 8-hour window does not drop them.
    this.liveActivityRenewal = new LiveActivityRenewalScheduler({
      repo: pushRepo,
      sender,
      sessionStore: this.sessionStore,
      serverId,
      serverLabel: hostname(),
    });
    this.liveActivityRenewal.start();
    // Host is logged (it selects sandbox vs production, a routine source of
    // "why is nothing arriving") but no credential material is.
    this.log.info("Live Activity push enabled", {
      event: "live_activity.enabled",
      host: creds.host,
      topic: `${creds.bundleId}.push-type.liveactivity`,
    });
  }

  /**
   * Bring up "your turn" notifications over Expo's relay (#528).
   *
   * Unconditional, unlike Live Activity push: Expo holds the app's APNs and FCM
   * credentials, so a self-hosted streamer needs no credential of its own. The
   * access token is optional and only relevant if the Expo project has enhanced
   * security enabled — requiring one would lock out every self-hoster, since
   * they do not own the project. It is never logged.
   */
  private initWaitingInputPush(pushRepo: PushRepository): void {
    const sender = new ExpoPushSender(pushRepo, process.env.THREADBASE_EXPO_ACCESS_TOKEN);
    const serverId = process.env.THREADBASE_INSTANCE_ID ?? hostname();
    this.waitingInputNotifier = new WaitingInputNotifier(sender, serverId, (id) =>
      this.hasSessionSubscriber(id),
    );
  }

  /** Whether any live socket is subscribed to this session — "someone is looking". */
  private hasSessionSubscriber(sessionId: string): boolean {
    const subs = this.sessionSubscribers.get(sessionId);
    if (!subs) return false;
    for (const ws of subs) {
      if (ws.readyState === ws.OPEN) return true;
    }
    return false;
  }

  /**
   * Release PTYs whose agent has been silent past IDLE_REAP_AFTER_MS.
   *
   * This is the bound that lets handleWsClose stop arming kill timers. The
   * distinction that matters: the old timer measured how long nobody was
   * *watching*, which is uncorrelated with whether work is in flight. This
   * measures how long the *agent* has produced nothing, and only ever considers
   * sessions that are already settled — a `running` PTY is skipped regardless of
   * age, so a long silent turn is never interrupted.
   *
   * Exposed (not private) so tests can drive one sweep deterministically instead
   * of waiting on the interval.
   */
  reapIdleSessions(now: number = Date.now()): string[] {
    if (this.ptyManager.isRemote()) return [];
    const reaped: string[] = [];
    for (const session of this.ptyManager.listSessions()) {
      // Never touch a session mid-turn. This is the whole point.
      if (session.status === "running") continue;

      // Fall back to startedAt so a session that never produced a chunk is
      // still eligible eventually — otherwise a PTY that failed to emit
      // anything would be immortal.
      const lastActive =
        this.lastAgentChunkAt.get(session.id) ??
        session.lastActivityAt?.getTime() ??
        session.startedAt.getTime();

      if (now - lastActive < IDLE_REAP_AFTER_MS) continue;

      this.log.info(
        `[reap] releasing idle PTY for ${session.id} (idle ${Math.round((now - lastActive) / 60_000)}m)`,
        { sessionId: session.id, event: "pty.idle_reap", idleMs: now - lastActive },
        "pino",
      );
      this.ptyManager.putOnHold(session.id);
      this.lastAgentChunkAt.delete(session.id);
      this.terminalSeq.delete(session.id);
      this.idempotency.clear(session.id);
      this.sessionSubscribers.delete(session.id);
      reaped.push(session.id);

      const held = this.sessionStore.get(session.id, this.ptyAttachedIds());
      if (held) this.wsHub.broadcast({ type: "session_update", session: held });
    }
    return reaped;
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
        //
        // But bound the deferral: a PTY that never settles (its last line was a
        // status bar with no prompt marker) would re-arm forever and leak.
        // After GRACE_MAX_DEFERS consecutive defers, hold it anyway.
        const resp = this.sessionStore.get(sessionId, this.ptyAttachedIds());
        if (resp?.status === "running") {
          const defers = (this.ptyGraceDeferCounts.get(sessionId) ?? 0) + 1;
          if (defers <= GRACE_MAX_DEFERS) {
            this.ptyGraceDeferCounts.set(sessionId, defers);
            this.log.info(
              `[grace] session ${sessionId} still running, deferring hold (${defers}/${GRACE_MAX_DEFERS})`,
              { sessionId, event: "pty.grace_defer", defers, maxDefers: GRACE_MAX_DEFERS },
              "pino",
            );
            this.startGraceTimer(sessionId, delayMs);
            return;
          }
          this.log.warn(
            `[grace] session ${sessionId} exceeded ${GRACE_MAX_DEFERS} defers, holding anyway`,
            { sessionId, event: "pty.grace_defer_cap", defers, maxDefers: GRACE_MAX_DEFERS },
            "pino",
          );
        }
        this.ptyGraceDeferCounts.delete(sessionId);
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
        this.ptyGraceDeferCounts.delete(sessionId);
        this.sessionSubscribers.delete(sessionId);
      }
    }, delayMs);

    this.ptyGraceTimers.set(sessionId, timer);
  }

  get port(): number {
    const addr = this.httpServer.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  private currentWarmupState(): ServerWarmupState | null {
    let current: ServerWarmupState | null = null;
    for (const state of this.activeWarmups.values()) current = state;
    return current;
  }

  private beginWarmup(state: ServerWarmupState): number {
    const id = this.nextWarmupId++;
    this.activeWarmups.set(id, state);
    return id;
  }

  private finishWarmup(id: number): void {
    if (!this.activeWarmups.delete(id) || this.activeWarmups.size > 0) return;
    this.wsHub.broadcast({ type: "cache_ready" });
  }

  private async withWarmup<T>(state: ServerWarmupState, operation: () => Promise<T>): Promise<T> {
    const id = this.beginWarmup(state);
    try {
      return await operation();
    } finally {
      this.finishWarmup(id);
    }
  }

  private rejectIfWarmingUp(res: ServerResponse): boolean {
    const warmupState = this.currentWarmupState();
    if (!warmupState) return false;
    const body: ServerWarmingUpResponse = {
      error: "Server is warming up",
      code: "SERVER_WARMING_UP",
      warmupState,
    };
    json(res, 503, body);
    return true;
  }

  async listen(port: number, opts?: { awaitReady?: boolean }): Promise<void> {
    if (this.featureFlags.ptyHost) {
      // Degrade to in-process runners rather than refusing to boot.
      //
      // `connectOrSpawnHost` rejects after ~5s if the host never accepts a
      // connection — a broken node-pty in the child, an unwritable socket
      // directory, a half-dead host still holding the path. Unhandled, that
      // makes an experimental, default-off flag the one subsystem that can stop
      // the streamer from starting at all, when every other optional subsystem
      // here (runtime store, cache, reconciliation) logs and continues.
      //
      // Safe to fall through: `useRemoteRunner` only disposes the in-process
      // runners *after* a successful connect, so on this path they are still
      // the live ones and nothing has been adopted.
      try {
        let sessions: ManagedSession[] | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const transport = await connectOrSpawnHost({
            instanceId: process.env.THREADBASE_INSTANCE_ID ?? hostname(),
          });
          try {
            sessions = await this.ptyManager.useRemoteRunner(transport);
            break;
          } catch (err) {
            if (!(err instanceof PtyHostProtocolMismatchError) || attempt > 0) throw err;
            this.log.info(`[pty-host] replaced incompatible protocol ${err.hostVersion}`, {
              event: "pty_host.protocol_replaced",
              hostVersion: err.hostVersion,
              streamerVersion: err.streamerVersion,
            });
          }
        }
        if (!sessions) throw new Error("pty-host replacement did not produce a compatible host");
        for (const session of sessions) {
          this.sessionStore.addManaged({ ...session, reconciled: true });
        }
        this.log.info(`[pty-host] re-adopted ${sessions.length} live session(s)`, {
          event: "pty_host.sessions_adopted",
          sessions: sessions.length,
        });
      } catch (err) {
        // Error, not warn: the operator asked for the host and is not getting
        // it, so sessions will not survive the next restart. Boot continues.
        this.log.error(
          "[pty-host] could not attach; falling back to in-process PTYs for this run",
          { event: "pty_host.attach_failed", err },
        );
      }
    }

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

    // unref() so an idle server with no other work can still exit — this timer
    // must never be the reason the process stays alive.
    if (!this.ptyManager.isRemote()) {
      this.idleReaperTimer = setInterval(() => this.reapIdleSessions(), IDLE_REAP_SWEEP_MS);
      this.idleReaperTimer.unref?.();
    }

    const warmUp = new Promise<void>((resolveWarm) => {
      {
        this.log.info(`Streamer server listening on port ${port}`, {
          port,
          event: "server.listening",
        });
        // Opened BEFORE and INDEPENDENTLY of the conversation cache. These two
        // used to share a handle, so the documented better-sqlite3 ABI mismatch
        // — which the cache catch below tolerates by design — silently took the
        // session registry with it: recordSpawn/recordStatus/recordShutdownState
        // all became no-ops with no separate signal. Each store now fails, and
        // logs, on its own.
        try {
          this.runtimeStore = RuntimeStore.open(this.runtimeDbPath);
          this.managedSessionsRepo = new ManagedSessionsRepository(this.runtimeStore.getDatabase());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const abiMismatch =
            message.includes("NODE_MODULE_VERSION") ||
            message.includes("was compiled against a different Node.js version");
          this.log.error(
            `Runtime store failed to open — session persistence DISABLED; ` +
              `sessions will not survive a restart.` +
              (abiMismatch ? ` Fix: npm rebuild better-sqlite3` : "") +
              ` (${message})`,
            { error: message, abiMismatch, path: this.runtimeDbPath, event: "runtime.open_failed" },
          );
        }
        if (this.ptyManager.isRemote()) {
          this.ptyManager.startRemoteHeartbeat(() => {
            if (!this.managedSessionsRepo) {
              return { registryState: "unknown", referencedSessionIds: [] };
            }
            const referencedSessionIds = this.ptyManager
              .listSessions()
              .filter((session) => this.managedSessionsRepo?.get(session.id)?.completed_at == null)
              .map((session) => session.id);
            return { registryState: "known", referencedSessionIds };
          });
        }
        try {
          this.cache = ConversationCache.open(
            join(this.cacheDir, "cache.db"),
            this.tailSize,
            undefined,
            {
              filterAgentConversations: !this.includeAgents,
              agentEntrypoints: this.agentEntrypoints,
              onAgentFileDetected: (fp) => {
                this.fileWatcher.unwatch(fp);
                // Release the external-tail slot too, otherwise an agent JSONL
                // holds a capped slot forever with a watcher that's already closed.
                this.externalTails.delete(canonicalizeFilePath(fp));
              },
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
          // One-time, non-destructive lift of a pre-split registry out of
          // cache.db. Never fatal: a failed copy costs one boot of post-restart
          // visibility, not the cache.
          try {
            const copied = this.runtimeStore?.importLegacyManagedSessions(db) ?? 0;
            if (copied > 0) {
              this.log.info(`Copied ${copied} managed session row(s) from cache.db to runtime.db`, {
                copied,
                event: "runtime.legacy_import",
              });
            }
          } catch (err) {
            this.log.warn("[registry] legacy managed_sessions copy failed", {
              event: "runtime.legacy_import_failed",
              err,
            });
          }
          this.cacheMetadataRepo = new CacheMetadataRepository(db);
          this.pushRepo = new PushRepository(db);

          this.devicesRepo = new DevicesRepository(db);
          this.initLiveActivityPush(this.pushRepo);
          this.initWaitingInputPush(this.pushRepo);
          // Cache-integrity drift monitor. reset_rescan rebuilds from a fresh
          // scan via the same machinery ?refresh=1 uses (rescanForRefresh).
          this.cacheMonitor = new CacheIntegrityMonitor(
            this.cache,
            this.wsHub,
            this.log,
            this.cacheDir,
            async () => {
              const scanner = await this.scannerManager.rescanForRefresh();
              return [...scanner.getMetadataCache().values()] as never;
            },
            (operation) => {
              const reset = this.withWarmup("cache_reset", operation);
              this.trackCacheWrite(reset);
              return reset;
            },
          );
          // Watch the active profile dirs (or ~/.claude/projects as fallback) so
          // new JSONL files created after startup are discovered and the scanner
          // and cache are invalidated without a restart. projectsDirs() is the
          // shared source of truth with findJsonlPath's degraded-mode discovery.
          for (const dir of this.scannerManager.projectsDirs()) {
            this.fileWatcher.watchDirectory(dir);
          }
          // Codex rollouts too (P4.a). Previously only the Claude projects dirs
          // were watched, so an externally-launched Codex session produced NO
          // event at all — it never even flipped the scanner-stale flag, making
          // it strictly pull-only. The roots are date-partitioned
          // (<root>/YYYY/MM/DD), so watch the root and let chokidar recurse.
          for (const dir of this.codexRoots) {
            if (!existsSync(dir)) continue;
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
          this.scannerManager.disablePersistence();
        }
        if (this.ptyManager.isRemote()) this.registryBoot.refreshHostedSessionsFromRegistry();
        // Classify whatever previous runs left behind. Fire-and-forget: it only
        // populates a diagnostic map, and blocking startup on `ps` probes would
        // delay the listener for no correctness gain. Runs after the cache block
        // so it sees any rows the legacy copy just brought across, and outside
        // it so a cache failure no longer skips reconciliation.
        void this.registryBoot.reconcilePreviousSessions().then(async (v) => {
          const recoverableRows = this.registryBoot.rehydratePreviousSessions(v);
          await this.registryBoot.autoResumePreviousSessions(recoverableRows);
          // Last, so retention can never delete a row this boot still wanted:
          // reconciliation has finished probing, rehydration has finished
          // seeding, and auto-resume has made its attempts before removal.
          this.registryBoot.pruneTerminalSessions();
        });
        // Opt out of the warm-up scan entirely (test hook). The cache and
        // repositories above are already open, so conversation endpoints serve an
        // empty cache instead of throwing; only the scan and its dependent cache
        // writes are skipped. Must still finish the warm-up bookkeeping, or
        // close() would await a promise that never settles.
        if (this.skipStartupWarmup) {
          this.log.debug?.("startup warm-up scan skipped (skipStartupWarmup)", {
            event: "cache.warmup_skipped",
          });
          this.finishWarmup(0);
          resolveWarm();
          return;
        }
        // Use a dedicated scanner for warm-up, independent of this.scannerManager.current, so
        // that onConversationChanged invalidations during the scan cannot cause
        // getScanner() to restart indefinitely and leave the warm-up stuck.
        const warmupStatCache = this.scannerManager.buildStatCache(null);
        // Scanner 0.9.4 reads statCache only in non-persistent scans.
        const warmupScanner = this.scannerManager.newScanner(
          warmupStatCache ? { persistent: false } : undefined,
        );
        this.scannerManager.track(warmupScanner);
        // Throttle the per-file onProgress firings to ~one frame per whole
        // percent (plus the final tick) so a large scan doesn't flood every
        // WebSocket client with thousands of scan_progress messages.
        const shouldEmitProgress = createScanProgressThrottle();
        const scanOpts = {
          ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
          ...this.scannerManager.codexScanOpts(),
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
            this.scannerManager.adoptIfUnclaimed(warmupScanner);
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
            // human resolves it; otherwise prune exactly as before. The
            // on-disk reconcile below is part of the same write path, so it
            // stays inside the freeze too.
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
              if (this.projectsRepo && this.conversationsRepo && this.cacheMetadataRepo) {
                refreshConversationCache({
                  cache: this.cache,
                  projectsRepo: this.projectsRepo,
                  conversationsRepo: this.conversationsRepo,
                  cacheMetadataRepo: this.cacheMetadataRepo,
                });
              } else if (this.cacheMetadataRepo) {
                setCacheMetadata(
                  this.cacheMetadataRepo,
                  "conversations_last_indexed_at",
                  new Date().toISOString(),
                );
              }
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
            this.finishWarmup(0);
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

  async close(): Promise<void> {
    for (const timer of this.ptyGraceTimers.values()) clearTimeout(timer);
    this.ptyGraceTimers.clear();
    if (this.idleReaperTimer) {
      clearInterval(this.idleReaperTimer);
      this.idleReaperTimer = null;
    }
    this.lastAgentChunkAt.clear();
    this.terminalSeq.clear();
    // An in-process runner is about to kill its children, so record that before
    // dispose() and before runtimeStore.close() takes the registry handle away.
    // A remote runner does the opposite: disconnect first so no late host event
    // can write through a closed handle, and leave its live registry rows alone.
    if (this.ptyManager.isRemote()) this.ptyManager.dispose();
    else this.registryBoot.recordShutdownState();
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
    await this.scannerManager.close();
    this.cache?.close();
    this.runtimeStore?.close();
    if (!this.ptyManager.isRemote()) this.ptyManager.dispose();
    this.fileWatcher.dispose();
    this.externalTails.clear();
    this.wsHub.dispose();
    this.pairTokens.dispose();
    // The APNs HTTP/2 session is long-lived by design, so it keeps the event
    // loop alive until closed explicitly.
    this.liveActivityRenewal?.stop();
    this.apnsClient?.close();
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

    const ts = new Date().toISOString();
    this.log.info(`[pair] token exchanged from ${ip} at ${ts}`, {
      event: "pair.token_exchanged",
      ip,
      ts,
    });

    // Mint a per-device credential alongside the shared key (C5). The sealed
    // apiKey is still returned so an existing client keeps working unchanged;
    // a client that understands deviceToken can use the narrower credential and
    // become individually revocable.
    //
    // Best-effort: a registry failure must not break pairing, which would lock
    // the user out of their own server. Losing the row costs revocability for
    // that device, not access.
    let device: { deviceId: string; deviceToken: string; capabilities: string[] } | null = null;
    try {
      const name = typeof body?.deviceName === "string" ? body.deviceName.slice(0, 100) : null;
      const preset = body?.readOnly === true ? "read-only" : "full";
      device = this.devicesRepo?.register({ publicKey: clientPublicKey, name, preset }) ?? null;
    } catch (err) {
      this.log.warn("[pair] device registration failed; pairing continues", {
        event: "pair.device_register_failed",
        err,
      });
    }

    json(res, 200, {
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      ephemeralPublicKey: sealed.ephemeralPublicKey,
      publicUrl: this.publicUrl,
      machineName: hostname(),
      ...(device && {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        capabilities: device.capabilities,
      }),
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

  /**
   * The registry ships with the values so a client renders the list from one
   * round-trip, same as getClaudeFlagsConfig().
   *
   * Deliberately no `persisted` field: unlike claude-flags there is no PUT, and
   * the absence of that field is the signal that this endpoint is read-only.
   */
  private getFeatureFlagsConfig(): {
    registry: typeof FEATURE_FLAGS;
    values: FeatureFlagValues;
  } {
    return { registry: FEATURE_FLAGS, values: this.featureFlags };
  }

  private getClaudeFlagsConfig(): {
    registry: typeof CLAUDE_FLAGS;
    values: ClaudeFlagValues;
    extraArgs: string | null;
    persisted: boolean;
  } {
    return {
      registry: CLAUDE_FLAGS,
      values: this.claudeFlags,
      extraArgs: this.claudeExtraArgs ?? null,
      persisted: this.claudeFlagsPersistable,
    };
  }

  /**
   * Replace the per-server flag set. Applies to the NEXT spawn — a live PTY
   * keeps the argv it was started with.
   *
   * Mirrors rotateApiKey(): when the values were pinned by a CLI flag we still
   * apply them in memory but skip the server.yaml write, because the flag would
   * win again on restart and silently revert them.
   *
   * Logged with old→new at info level on purpose: this can disable the
   * permission prompts entirely, so it needs a forensic trail.
   */
  private setClaudeFlagsConfig(
    values: ClaudeFlagValues,
    extraArgs: string | undefined,
  ): { values: ClaudeFlagValues; extraArgs: string | null; persisted: boolean } {
    const safe = validateFlagValues(values);
    const previous = { values: this.claudeFlags, extraArgs: this.claudeExtraArgs };

    if (this.claudeFlagsPersistable) {
      // setClaudeExtraArgs throws on an embedded newline; let it propagate so
      // the route answers 400 rather than writing a corrupt config line.
      setClaudeExtraArgs(extraArgs);
      setClaudeFlags(safe);
    }
    this.claudeFlags = safe;
    this.claudeExtraArgs = extraArgs?.trim() ? extraArgs.trim() : undefined;

    this.log.info("Claude CLI flags updated", {
      event: "config.claude_flags_updated",
      persisted: this.claudeFlagsPersistable,
      previousValues: previous.values,
      previousExtraArgs: previous.extraArgs ?? null,
      values: this.claudeFlags,
      extraArgs: this.claudeExtraArgs ?? null,
    });

    return {
      values: this.claudeFlags,
      extraArgs: this.claudeExtraArgs ?? null,
      persisted: this.claudeFlagsPersistable,
    };
  }

  /**
   * The three spawn options that a configured claude-flag can override, with
   * the boot-time CLI/yaml default as the fallback. Spread into every
   * start/resume/adopt call so all three paths agree.
   *
   * These ids are excluded from buildFlagArgs (SPAWN_POSITIONAL_FLAG_IDS)
   * precisely because they arrive here instead — the PTY spawn paths pass them
   * as explicit positionals, so emitting them from the allowlist too would
   * duplicate the flag.
   *
   * Narrowed with the type guards rather than cast: ClaudeFlagValues is a loose
   * Record by design, and while validateFlagValues already guarantees the shape
   * on the way in, TypeScript cannot see that through the record.
   */
  private spawnFlagOverrides(): {
    permissionMode: PermissionMode;
    model: string;
    effort: EffortLevel;
  } {
    const mode = this.claudeFlags.permissionMode;
    const model = this.claudeFlags.model;
    const effort = this.claudeFlags.effort;
    return {
      permissionMode: isPermissionMode(mode) ? mode : this.defaultPermissionMode,
      model: typeof model === "string" ? model : this.defaultModel,
      effort: isEffortLevel(effort) ? effort : this.defaultEffort,
    };
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

  private handleSessionsCount(res: ServerResponse): void {
    if (this.rejectIfWarmingUp(res)) return;
    // Recovered stubs are excluded: this badge means "sessions this streamer is
    // running", and a restart must not inflate it with everything it could
    // offer to resume. The updater's active-session probe reads the same number.
    const total = this.sessionStore
      .list(this.ptyAttachedIds())
      .filter((s) => s.ownership !== "historical").length;
    json(res, 200, { total });
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

  /**
   * Resolve a client-supplied session/conversation id into everything needed to
   * launch against it: the id the PROVIDER filed the history under, that
   * history's path, the project cwd, and which CLI owns it.
   *
   * Shared by resume and fork so the two can never disagree about identity —
   * which for Codex is the whole difficulty: the id a client navigated to may
   * be a local placeholder, and only the registry knows the rollout id behind
   * it.
   */
  private async resolveConversationTarget(sessionId: string): Promise<
    | ResumeFailure
    | {
        ok: true;
        historyId: string;
        jsonlPath: string | null;
        historyPath: string | null;
        conv: any;
        projectPath: string;
        provider: ProviderName;
      }
  > {
    // Authoritative cwd comes from the JSONL itself — the file Claude looks
    // up by filename when processing --resume. The scanner index can return a
    // stale or wrong path (e.g. …/tb-mobile/android vs …/tb-mobile), so we
    // read the first cwd field directly, mirroring tb-scanner/src/parser.ts.
    let jsonlPath = this.conversationHandlers.findJsonlPath(sessionId);
    let conv = await this.conversationHandlers.findConversationByUuid(sessionId);

    // Nothing resolves for a *fresh Codex* session id: it is a local
    // placeholder, and Codex indexes its history under the rollout id it
    // assigned itself. The registry is what remembers which is which, so fall
    // back to the bound id and resolve path + history from there (G6). The
    // session keeps the placeholder id the client navigated to — only argv and
    // these lookups use the bound one.
    let historyId = sessionId;
    let registryProvider: string | undefined;
    if (!jsonlPath && !conv) {
      const row = this.managedSessionsRepo?.get(sessionId) ?? null;
      const boundId = row ? resumeIdForRow(row) : null;
      if (boundId != null && boundId !== sessionId) {
        historyId = boundId;
        registryProvider = row?.provider;
        jsonlPath = this.conversationHandlers.findJsonlPath(boundId);
        conv = await this.conversationHandlers.findConversationByUuid(boundId);
      }
    }

    const jsonlCwd = jsonlPath ? await this.conversationHandlers.readCwdFromJsonl(jsonlPath) : null;
    const projectPath: string = jsonlCwd ?? (conv as any)?.projectPath;
    if (!projectPath) {
      // Nothing at all resolved — the history file is gone, not merely
      // unreadable. Distinguished from "path unknown" because it is permanent:
      // the caller must not retry it.
      if (!conv && !jsonlPath) return { ok: false, reason: "history_file_missing" };
      return { ok: false, reason: "no_project_path" };
    }

    // Same provider-resolution fallback as the conversation-detail path
    // (server.ts ~1685): `conv` (the full Conversation shape) doesn't carry
    // provider, so fall back to the cached metadata, then default to Claude.
    // …and, when the fallback above fired, the registry row's own provider as a
    // last resort: neither lookup is keyed by the placeholder id, so without it
    // a Codex placeholder would default to Claude and spawn the wrong CLI.
    const cachedConvMeta = this.cache?.getMetaById(historyId);
    const provider = coerceProviderForRunner(
      (conv as any)?.provider ?? cachedConvMeta?.provider ?? registryProvider,
    );

    return {
      ok: true,
      historyId,
      jsonlPath,
      // findJsonlPath() only knows Claude's `<uuid>.jsonl` layout under
      // ~/.claude/projects; a Codex rollout lives in a date-nested directory
      // under a name it chose, so its path only ever comes from the indexed
      // conversation. Kept separate from `jsonlPath` deliberately: feeding it to
      // conversationBusy() would newly arm the mtime heuristic for Codex, which
      // is exactly the over-broad signal the report ruled out.
      historyPath: jsonlPath ?? ((conv as any)?.filePath as string | undefined) ?? null,
      conv,
      projectPath,
      provider,
    };
  }

  /**
   * Block until a freshly spawned session reaches `waiting_input` (ready) or
   * `idle` (failed), or until `timeoutMs` elapses with the process still alive.
   *
   * "timeout" is not an error: it is the pre-existing asynchronous contract —
   * the session keeps booting and the caller answers with a pending shape.
   */
  private waitForStartupOutcome(
    sessionId: string,
    timeoutMs: number,
  ): Promise<{ outcome: "ready" | "failed" | "timeout"; session: ManagedSession | null }> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const handler = (status: string, session?: ManagedSession) => {
        if (status !== "waiting_input" && status !== "idle") return;
        this.sessionStatusBus.off(`status:${sessionId}`, handler);
        if (timer) clearTimeout(timer);
        resolve({
          outcome: status === "waiting_input" ? "ready" : "failed",
          session: session ?? null,
        });
      };
      this.sessionStatusBus.on(`status:${sessionId}`, handler);
      timer = setTimeout(() => {
        this.sessionStatusBus.off(`status:${sessionId}`, handler);
        resolve({ outcome: "timeout", session: null });
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /**
   * Drop every trace of a session that never became usable, and hand back what
   * it failed with.
   *
   * The runner has already torn itself down (failStartup / handleExit); what
   * remains is server-side bookkeeping that would otherwise leave a dead
   * session in the list, a registry row claiming a spawn, and a `selfPtyEndedAt`
   * marker that would suppress the mtime collision signal on the NEXT resume —
   * i.e. it would help hide the very owner we just collided with.
   */
  private abandonFailedStart(sessionId: string): void {
    this.sessionStore.removeManaged(sessionId);
    this.selfPtyEndedAt.delete(sessionId);
    this.contendedSessions.delete(sessionId);
    try {
      this.managedSessionsRepo?.delete(sessionId);
    } catch (err) {
      this.log.warn("[registry] failed to drop a failed start", {
        event: "registry.forget_failed",
        sessionId,
        err,
      });
    }
  }

  private enrichResumedSessionAsync(sessionId: string, projectPath: string, conv: any): void {
    try {
      // Writes go through updateManaged: sessionStore.get() would hand back a
      // response copy and every assignment below would be silently discarded.
      // The store holds `ManagedSession`, so the timestamps are Dates here —
      // managedToResponse serializes them, as it already does for startedAt.
      if (!this.sessionStore.getManaged(sessionId)) return;

      if (conv) {
        this.sessionStore.updateManaged(sessionId, {
          sessionName: conv.sessionName ?? undefined,
          messageCount: conv.messageCount ?? 0,
          account: conv.account ?? undefined,
          filePath: conv.filePath ?? undefined,
        });
      }

      if (!this.cache || !this.projectsRepo || !this.conversationsRepo) return;

      // Single SQLite read covers model, preview, timestamps, and projectId —
      // no scanner round-trip needed; these fields are already cached.
      const cached = this.cache.getMetaById(sessionId);
      if (cached) {
        const first = cached.firstMessage ? JSON.parse(cached.firstMessage as string) : null;
        const last = cached.lastMessage ? JSON.parse(cached.lastMessage as string) : null;
        this.sessionStore.updateManaged(sessionId, {
          model: cached.model ?? undefined,
          preview: cached.preview ?? undefined,
          firstMessageText: first?.text ?? undefined,
          // parseIsoDateOrNull, not `new Date()`: an unparseable cached
          // timestamp must land as absent, not as an Invalid Date that
          // managedToResponse would throw on when it calls .toISOString().
          firstMessageAt: parseIsoDateOrNull(first?.timestamp) ?? undefined,
          lastMessageText: last?.text ?? undefined,
          lastMessageAt: parseIsoDateOrNull(last?.timestamp) ?? undefined,
        });
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
        this.sessionStore.updateManaged(sessionId, {
          projectId: resolvedProjectId,
          resumedFromConversationId: sessionId,
        });
      }
    } catch (err) {
      // ponytail: log but don't crash; session is already live and usable
      console.error(`[enrichResumedSessionAsync] ${sessionId}:`, err);
    }
  }

  // Store + broadcast AskUserQuestion cards found in a JSONL batch for a watched
  // session. Two P0 safety guards on top of the screen/JSONL de-dupe:
  //   (a) contended file → suppress JSONL-derived cards entirely (a line may be
  //       the OTHER owner's question); the streamer's own PTY questions still
  //       arrive via the live-screen path (handleLiveQuestion), not suppressed.
  //   (b) a JSONL question must never clobber a PTY-screen question that is a
  //       DIFFERENT question — answering it would type into this streamer's PTY.
  //       Same-content re-syncs (screen synthetic id → real toolUseId) still pass.
  private processJsonlQuestions(sessionId: string, lines: string[]): void {
    // toolUseId the client currently holds for this session (set by the
    // live-screen path as `screen:…`, or a prior JSONL flush). Captured BEFORE
    // the overwrite below so we can detect an id change.
    const priorPending = this.pendingQuestions.get(sessionId);
    const priorToolUseId = priorPending?.toolUseId;
    const contended = this.contendedSessions.has(sessionId);
    const priorPtyKey =
      priorPending?.origin === "pty" ? questionContentKey(priorPending.questions) : null;
    const foreignVsPty = (questions: AskQuestion[]): boolean =>
      priorPtyKey !== null && questionContentKey(questions) !== priorPtyKey;
    const { messages, pending } = questionsFromLines(sessionId, lines);
    for (const p of pending) {
      if (contended || foreignVsPty(p.questions)) continue;
      // Preserve a same-question re-sync's "pty" origin so a later foreign JSONL
      // question still can't clobber it.
      const origin: "pty" | "jsonl" =
        priorPtyKey !== null && questionContentKey(p.questions) === priorPtyKey ? "pty" : "jsonl";
      this.pendingQuestions.set(sessionId, { ...p, origin }); // last pending wins
      const t = setTimeout(() => {
        if (this.pendingQuestions.get(sessionId)?.toolUseId === p.toolUseId) {
          this.cancelPendingQuestion(sessionId);
        }
      }, 60_000);
      t.unref();
    }
    // De-dupe vs the live-screen path: if the rendered detection already
    // broadcast this exact question (same content key), don't re-render —
    // EXCEPT when the real JSONL toolUseId differs from the synthetic `screen:`
    // id the client holds. The client answers with the id it was given; if it
    // still has the screen id, resolveAnswer rejects the POST as
    // tool_use_mismatch. Re-broadcasting the real id re-syncs the client
    // (mapAskQuestionToBlock just replaces activeQuestion — the card re-renders
    // identically) so answering works.
    for (const m of messages) {
      // Same suppression as the pending loop: never render a JSONL card for a
      // contended file, nor a foreign question over a live PTY one.
      if (contended || foreignVsPty(m.questions)) continue;
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
  }

  private cancelPendingQuestion(sessionId: string): void {
    const pq = this.pendingQuestions.get(sessionId);
    if (!pq) return;
    this.pendingQuestions.delete(sessionId);
    this.pendingQuestionKey.delete(sessionId);
    this.wsHub.broadcast({ type: "question_cancelled", sessionId, toolUseId: pq.toolUseId });
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
      const [directories, files] = await Promise.all([
        listDirectories(resolved),
        listFiles(resolved),
      ]);
      json(res, 200, { path: relativePath, directories, files });
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

  /**
   * Retarget a LIVE session's model or effort by typing the corresponding
   * Claude Code slash command into its PTY.
   *
   * There is no CLI or IPC channel for this — `--model`/`--effort` are spawn
   * arguments — so the interactive `/model <x>` / `/effort <y>` commands are the
   * only way to change a session already running. Both accept an argument and
   * apply it without opening the picker (verified against Claude Code v2.1.220).
   *
   * Answers 202, not 200: the value is applied by the TUI on its next render, so
   * there is nothing truthful to echo back synchronously. Clients confirm with
   * `GET /api/sessions/:id`, which scrapes the applied value off the live status
   * line.
   */
  private async applyLiveSessionSetting(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
    setting: "model" | "effort",
  ): Promise<void> {
    // Both putOnHold() and handleExit() DELETE the session from the runner's
    // map, so "no live PTY" reads as absent here, not as status "idle". Fall back
    // to the registry to tell a held/exited session (409, resume it) apart from
    // an id that was never ours (404) — mobile holds sessions routinely via the
    // grace timer, and answering 404 for one it can see in its list is a lie.
    const session = this.ptyManager.getSession(sessionId);
    if (!session) {
      const known = this.sessionStore.getManaged(sessionId);
      if (known) {
        json(res, 409, {
          error: "Session has no live PTY; resume it first",
          code: "SESSION_IDLE",
        });
        return;
      }
      json(res, 404, { error: "Session not found" });
      return;
    }
    if ((session.provider ?? CLAUDE_CODE_PROVIDER) !== CLAUDE_CODE_PROVIDER) {
      json(res, 501, {
        error: `Setting ${setting} on a ${session.provider} session is not supported`,
        code: "UNSUPPORTED_PROVIDER",
      });
      return;
    }
    // Mid-turn the composer is not accepting a slash command, so the injected
    // text would be swallowed or garbled. Make the caller wait for the turn.
    if (session.status === "running") {
      json(res, 409, {
        error: "Session is mid-turn; retry once it is waiting for input",
        code: "SESSION_BUSY",
      });
      return;
    }

    let parsed: { model?: unknown; effort?: unknown };
    try {
      parsed = await readBody(req);
    } catch {
      json(res, 400, { error: "Invalid JSON" });
      return;
    }

    // TRUST BOUNDARY: this value is written as raw bytes into a live terminal.
    // An unvalidated \r would end the slash command and let the rest of the
    // string run as a second, attacker-chosen command. Validate, never escape.
    let value: string;
    if (setting === "effort") {
      if (!isEffortLevel(parsed.effort)) {
        json(res, 400, {
          error: `effort must be one of ${EFFORT_LEVELS.join(", ")}`,
        });
        return;
      }
      value = parsed.effort;
    } else {
      if (typeof parsed.model !== "string" || !MODEL_NAME_RE.test(parsed.model)) {
        json(res, 400, {
          error:
            "model must be an alias or full model name (letters, digits, dot, dash, underscore)",
        });
        return;
      }
      value = parsed.model;
    }

    try {
      this.ptyManager.sendKeys(sessionId, `/${setting} ${value}\r`);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : "Failed to write to session" });
      return;
    }
    this.log.info(`Live session ${setting} set to ${value}`, {
      event: "session.setting_applied",
      sessionId,
      setting,
      value,
    });
    json(res, 202, { id: sessionId, [setting]: value });
  }
}

// ─── Utilities ─────────────────────────────────────────────────────

// Parse THREADBASE_DIR_SCAN_DEBOUNCE_MS → a non-negative integer, or undefined
// when unset/invalid so the caller can fall through to config/default.
function parseDirScanDebounceEnv(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
}
