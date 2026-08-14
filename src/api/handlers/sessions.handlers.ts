import type { EventEmitter } from "events";
import { existsSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { basename, dirname, join } from "path";
import type { WebSocket } from "ws";
import type { AgentClient } from "../../agent/agent-client";
import type { AgentConfig } from "../../agent/agent-config";
import { handleSendAgentInput } from "../../agent/handle-send-agent-input";
import { handleStartAgentSession } from "../../agent/handle-start-agent-session";
import { resolveBrowsePath } from "../../browse";
import type { ClaudeFlagValues, EffortLevel, PermissionMode } from "../../claude-flags";
import { CODEX_ACTIVE_WRITER_CODE } from "../../codex-pty-runner";
import type { ConversationCache } from "../../conversation-cache";
import type { createPool } from "../../db";
import { recordUpload } from "../../db/upload-records";
import type { ExternalTailManager } from "../../external-tails";
import type { LiveSessionManager } from "../../live-session-manager";
import type { Logger } from "../../logger";
import { discoverClaudeProcesses } from "../../process-discovery";
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_CLI_PROVIDER,
  isProviderName,
  type ProviderName,
} from "../../providers";
import type { ScannerManager } from "../../scanner-manager";
import type { ResumeFailure, ResumeOutcome } from "../../server";
import { permissionContentKey } from "../../services/questions/detectPermissionGate";
import { questionContentKey } from "../../services/questions/detectQuestionFromScreen";
import { parseStatusLine } from "../../services/questions/parseStatusLine";
import { resolveAnswer } from "../../services/questions/resolveAnswer";
import { type CodexOwnerSource, findRolloutOwner } from "../../services/sessions/codexRolloutOwner";
import {
  type BusySignal,
  conversationBusy,
  resolveResumeBusyWindowMs,
} from "../../services/sessions/conversationBusy";
import type { IdempotencyStore } from "../../services/sessions/idempotency";
import { readIdempotencyKey } from "../../services/sessions/idempotency";
import type { SessionRegistryBoot } from "../../session-registry-boot";
import type { SessionStore } from "../../session-store";
import type { SessionWatchers } from "../../session-watchers";
import type {
  AskQuestion,
  DiscoveredProcess,
  ManagedSession,
  PermissionOption,
  SessionResponse,
} from "../../types";
import { saveUploadFile } from "../../uploads";
import type { WSHub } from "../../ws-hub";
import {
  classifyResumability,
  conversationToResumableSession,
  json,
  parseSessionListQuery,
  readBody,
} from "./http-helpers";

const BROWSE_SYSTEM_PROMPT = (browseRoot: string) =>
  `You are working within the project boundary: ${browseRoot}. ` +
  `Do not read, write, or execute commands that access files or directories outside this boundary.`;

// Upper bound on the process-discovery half of the resume collision probe.
// Enumerating processes costs one CIM/wmic query per pid on Windows, so a
// machine with several CLIs open can take seconds — unacceptable on a path the
// user is waiting on. Past this we fall back to the jsonl_mtime signal alone.
export const RESUME_DISCOVERY_TIMEOUT_MS = 750;

// How long adopt waits for the external process to actually exit after SIGTERM
// before giving up. Exceeding this means the takeover would spawn a second agent
// alongside a live one, so adopt aborts instead.
// How long a discovered-process list stays usable. Shared by the sessions list
// and the resume collision probe so a resume can reuse a warm enumeration.
const DISCOVERY_TTL_MS = 15_000;

export const ADOPT_KILL_TIMEOUT_MS = 5_000;
const ADOPT_KILL_POLL_MS = 100;

// Session start blocks for the PTY to reach waiting_input/idle before
// responding; past this we fall back to the async 202 shape. Must stay BELOW
// the mobile client's start-request fetch timeout (15s) — at the old 15s value
// the client aborted first ("fetch canceled") and its retry double-spawned
// sessions. Ready normally lands well under this: Claude's quiet-checker and
// Codex's CODEX_READY_FALLBACK_MS (8s) both settle pendingReady first.
const START_READY_TIMEOUT_MS = 10_000;

// How long a Codex resume/fork waits for an authoritative startup outcome
// before falling back to the pre-existing "spawned, still booting" behaviour.
//
// Deliberately shorter than START_READY_TIMEOUT_MS: this window only has to
// cover Codex FAILING, and the writer-lock refusal happens when it opens the
// rollout — before the TUI boots at all — not after the 8s ready fallback. A
// resume that is merely slow to paint still answers 201 and finishes booting in
// the background, exactly as it did before.
const CODEX_STARTUP_TIMEOUT_MS = 4_000;

function resolveCodexStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.THREADBASE_CODEX_STARTUP_TIMEOUT_MS;
  if (raw === undefined) return CODEX_STARTUP_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : CODEX_STARTUP_TIMEOUT_MS;
}

// Poll until `pid` is gone (signal 0 throws ESRCH) or the timeout elapses.
// Returns true when the process is confirmed gone. Used by adopt so a takeover
// never spawns a second agent while the one it replaces is still alive.
export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollMs: number = ADOPT_KILL_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH (or no longer visible to us) — it is gone.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * The 409 body for a Codex conversation another client already owns.
 *
 * Keeps `code: "CONVERSATION_BUSY"` on purpose: released mobile builds switch
 * on that string, and a new top-level code would land as a generic network
 * error with no recovery UI. The Codex-specific truth is carried additively —
 * `reasonCode` names the real cause, and the capability flags say what the
 * client may offer, so nothing has to be inferred from `likelyOwner`.
 *
 * `canForce` is false because `force` only ever bypassed OUR heuristic; Codex's
 * writer lock is enforced inside Codex. `canTakeOver` is false because the
 * owner may be a shared VS Code / desktop app-server hosting unrelated threads,
 * and there is no way to prove otherwise today.
 */
function codexSessionActiveBody(outcome: {
  detectedBy: BusySignal[];
  lastActivityMs: number | null;
  ownerPid?: number;
  ownerSource?: CodexOwnerSource;
}): Record<string, unknown> {
  return {
    error: "This Codex session is already open in another client",
    code: "CONVERSATION_BUSY",
    reasonCode: "CODEX_SESSION_ACTIVE",
    provider: CODEX_CLI_PROVIDER,
    detectedBy: outcome.detectedBy,
    lastActivityMs: outcome.lastActivityMs,
    likelyOwner: "external",
    canForce: false,
    canTakeOver: false,
    canFork: true,
    ...(outcome.ownerPid != null && { ownerPid: outcome.ownerPid }),
    ...(outcome.ownerSource != null && { ownerSource: outcome.ownerSource }),
  };
}

/**
 * Everything SessionHandlers reads from the server. Same split as
 * ConversationHandlersDeps: collaborators the server constructor already built
 * are passed by reference (Maps and Sets keep identity, so a mutation here is
 * the same mutation the server and its tests observe), anything bound later or
 * swapped by tests is a thunk, and the handful of methods that stay on
 * StreamerServer are late-bound calls back into it.
 *
 * Nothing here owns state. `pendingQuestions`, `pendingPermission`,
 * `contendedSessions`, `selfPtyEndedAt`, `sessionFileMap`, `sessionSubscribers`
 * and `idempotency` remain StreamerServer instance properties — tests reach
 * into them through `(server as any)`, and the WS/PTY callbacks that also read
 * them never moved.
 */
export type SessionHandlersDeps = {
  sessionStore: SessionStore;
  ptyManager: LiveSessionManager;
  wsHub: WSHub;
  scannerManager: ScannerManager;
  sessionWatchers: SessionWatchers;
  registryBoot: SessionRegistryBoot;
  externalTailManager: ExternalTailManager;
  idempotency: IdempotencyStore;
  sessionStatusBus: EventEmitter;
  sessionFileMap: Map<string, string>;
  pendingQuestions: Map<
    string,
    { toolUseId: string; questions: AskQuestion[]; origin: "pty" | "jsonl" }
  >;
  pendingQuestionKey: Map<string, string>;
  pendingPermission: Map<
    string,
    { prompt?: string; detail?: string; options: PermissionOption[]; cursor?: number }
  >;
  pendingPermissionKey: Map<string, string>;
  contendedSessions: Set<string>;
  selfPtyEndedAt: Map<string, number>;
  sessionSubscribers: Map<string, Set<WebSocket>>;
  agentConfig: AgentConfig;
  agentClient: AgentClient | null;
  defaultSystemPrompt: string;
  codexSystemPromptEnabled: boolean;
  cacheDir: string;

  // Late-bound: opened during listen(), rebound by the integrity monitor's
  // reset-and-rescan, mutated by PUT /api/config/claude-flags, resolved
  // asynchronously at boot (browseRoot), or swapped on the instance by tests.
  cache: () => ConversationCache | null;
  log: () => Logger;
  browseRoot: () => string | null;
  claudeFlags: () => ClaudeFlagValues;
  claudeExtraArgs: () => string | undefined;
  dbPool: () => Awaited<ReturnType<typeof createPool>> | null;
  dbInstanceId: () => string | null;

  // The discovered-process cache and its single-flight. Read and written from
  // here, but owned by StreamerServer — close() and the session list read them.
  discoveryCache: () => { entries: DiscoveredProcess[]; fetchedAt: number } | null;
  setDiscoveryCache: (value: { entries: DiscoveredProcess[]; fetchedAt: number } | null) => void;
  discoveryInFlight: () => Promise<DiscoveredProcess[]> | null;
  setDiscoveryInFlight: (value: Promise<DiscoveredProcess[]> | null) => void;

  // Methods that stay on StreamerServer.
  rejectIfWarmingUp: (res: ServerResponse) => boolean;
  ptyAttachedIds: () => Set<string>;
  withReconciledLifecycle: (sessions: readonly SessionResponse[]) => readonly SessionResponse[];
  broadcastOrUnicastSessionList: (req: IncomingMessage) => void;
  checkSessionStartRateLimit: (ip: string) => boolean;
  checkSessionInputRateLimit: (sessionId: string) => boolean;
  spawnFlagOverrides: () => {
    permissionMode: PermissionMode;
    model: string;
    effort: EffortLevel;
  };
  resolveConversationTarget: (sessionId: string) => Promise<
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
  >;
  waitForStartupOutcome: (
    sessionId: string,
    timeoutMs: number,
  ) => Promise<{ outcome: "ready" | "failed" | "timeout"; session: ManagedSession | null }>;
  abandonFailedStart: (sessionId: string) => void;
  enrichResumedSessionAsync: (sessionId: string, projectPath: string, conv: any) => void;
  findJsonlPath: (uuid: string) => string | null;
  readCwdFromJsonl: (filePath: string) => Promise<string | null>;
};

/**
 * The session lifecycle surface: list/get, start, resume, fork, adopt, input,
 * answers, permission gates, uploads, stop/cancel and session names.
 *
 * Extracted from StreamerServer so session work stops editing the server file
 * (see docs/plans/2026-07-12-server-ts-split.md, PR 8). State stays on the
 * server: this class only reads and mutates it through `deps`.
 */
export class SessionHandlers {
  constructor(private deps: SessionHandlersDeps) {}

  private get sessionStore(): SessionStore {
    return this.deps.sessionStore;
  }

  private get ptyManager(): LiveSessionManager {
    return this.deps.ptyManager;
  }

  private get wsHub(): WSHub {
    return this.deps.wsHub;
  }

  private get scannerManager(): ScannerManager {
    return this.deps.scannerManager;
  }

  private get sessionWatchers(): SessionWatchers {
    return this.deps.sessionWatchers;
  }

  private get registryBoot(): SessionRegistryBoot {
    return this.deps.registryBoot;
  }

  private get externalTailManager(): ExternalTailManager {
    return this.deps.externalTailManager;
  }

  private get idempotency(): IdempotencyStore {
    return this.deps.idempotency;
  }

  private get sessionStatusBus(): EventEmitter {
    return this.deps.sessionStatusBus;
  }

  private get sessionFileMap(): Map<string, string> {
    return this.deps.sessionFileMap;
  }

  private get pendingQuestions(): SessionHandlersDeps["pendingQuestions"] {
    return this.deps.pendingQuestions;
  }

  private get pendingQuestionKey(): Map<string, string> {
    return this.deps.pendingQuestionKey;
  }

  private get pendingPermission(): SessionHandlersDeps["pendingPermission"] {
    return this.deps.pendingPermission;
  }

  private get pendingPermissionKey(): Map<string, string> {
    return this.deps.pendingPermissionKey;
  }

  private get contendedSessions(): Set<string> {
    return this.deps.contendedSessions;
  }

  private get selfPtyEndedAt(): Map<string, number> {
    return this.deps.selfPtyEndedAt;
  }

  private get sessionSubscribers(): Map<string, Set<WebSocket>> {
    return this.deps.sessionSubscribers;
  }

  private get agentConfig(): AgentConfig {
    return this.deps.agentConfig;
  }

  private get agentClient(): AgentClient | null {
    return this.deps.agentClient;
  }

  private get defaultSystemPrompt(): string {
    return this.deps.defaultSystemPrompt;
  }

  private get codexSystemPromptEnabled(): boolean {
    return this.deps.codexSystemPromptEnabled;
  }

  private get cacheDir(): string {
    return this.deps.cacheDir;
  }

  private get cache(): ConversationCache | null {
    return this.deps.cache();
  }

  private get log(): Logger {
    return this.deps.log();
  }

  private get browseRoot(): string | null {
    return this.deps.browseRoot();
  }

  private get claudeFlags(): ClaudeFlagValues {
    return this.deps.claudeFlags();
  }

  private get claudeExtraArgs(): string | undefined {
    return this.deps.claudeExtraArgs();
  }

  private get dbPool(): Awaited<ReturnType<typeof createPool>> | null {
    return this.deps.dbPool();
  }

  private get dbInstanceId(): string | null {
    return this.deps.dbInstanceId();
  }

  private get discoveryCache(): { entries: DiscoveredProcess[]; fetchedAt: number } | null {
    return this.deps.discoveryCache();
  }

  private set discoveryCache(value: { entries: DiscoveredProcess[]; fetchedAt: number } | null) {
    this.deps.setDiscoveryCache(value);
  }

  private get discoveryInFlight(): Promise<DiscoveredProcess[]> | null {
    return this.deps.discoveryInFlight();
  }

  private set discoveryInFlight(value: Promise<DiscoveredProcess[]> | null) {
    this.deps.setDiscoveryInFlight(value);
  }

  async handleListSessions(url: URL, res: ServerResponse): Promise<void> {
    if (this.deps.rejectIfWarmingUp(res)) return;

    await this.refreshDiscovery();

    // Backwards compat: a bare GET /api/sessions returns the legacy plain
    // array. Any pagination param switches to the new envelope.
    const hasPaginationParams =
      url.searchParams.has("limit") ||
      url.searchParams.has("cursor") ||
      url.searchParams.has("sortBy") ||
      url.searchParams.has("order") ||
      url.searchParams.has("status");

    if (!hasPaginationParams) {
      json(
        res,
        200,
        this.externalTailManager.withExternalActivity(
          this.deps.withReconciledLifecycle(this.sessionStore.list(this.deps.ptyAttachedIds())),
        ),
      );
      return;
    }

    const parsed = parseSessionListQuery(url);
    if ("error" in parsed) {
      json(res, 400, { error: parsed.error });
      return;
    }

    try {
      const page = this.sessionStore.paginate(this.deps.ptyAttachedIds(), parsed.query);
      page.sessions = this.externalTailManager.withExternalActivity(
        this.deps.withReconciledLifecycle(page.sessions),
      );
      json(res, 200, page);
    } catch (err) {
      if (err instanceof Error && err.message === "INVALID_CURSOR") {
        json(res, 400, { error: "Invalid cursor" });
        return;
      }
      throw err;
    }
  }

  /**
   * Refresh the discovered-process list, sharing one in-flight enumeration
   * across concurrent callers and honouring the 15s TTL cache.
   */
  private async refreshDiscovery(): Promise<DiscoveredProcess[]> {
    const cached = this.discoveryCache;
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
      return cached.entries;
    }
    if (this.discoveryInFlight) {
      return this.discoveryInFlight;
    }

    let flight!: Promise<DiscoveredProcess[]>;
    flight = (async (): Promise<DiscoveredProcess[]> => {
      try {
        const discovered = await discoverClaudeProcesses();
        this.sessionStore.setDiscovered(discovered);
        this.discoveryCache = { entries: discovered, fetchedAt: Date.now() };
        return discovered;
      } catch {
        // Discovery is best-effort — keep any previous cache rather than
        // remembering a failure as "nothing is running".
        return this.discoveryCache?.entries ?? [];
      } finally {
        if (this.discoveryInFlight === flight) {
          this.discoveryInFlight = null;
        }
      }
    })();

    this.discoveryInFlight = flight;
    return flight;
  }

  async handleGetSession(sessionId: string, res: ServerResponse): Promise<void> {
    if (this.deps.rejectIfWarmingUp(res)) return;
    // A response copy, so decorating it means building a new object — see
    // SessionStore.get(). Persisting anything here would need updateManaged().
    const base = this.sessionStore.get(sessionId, this.deps.ptyAttachedIds());
    if (base) {
      // Apply a boot-reconciliation verdict if one exists for this session and
      // it isn't live here — the detail screen is where the distinction between
      // `detached` and `orphaned` actually matters to a user.
      const reconciled = this.deps.withReconciledLifecycle([base])[0];
      const session: SessionResponse = {
        ...base,
        ...(existsSync(base.projectPath)
          ? {}
          : { failureReason: `Project directory not found: ${base.projectPath}` }),
        lifecycle: reconciled.lifecycle,
        lifecycleSource: reconciled.lifecycleSource,
      };
      // Scrape model/effort/permission-mode off the live PTY's rendered status
      // line so the client can show them natively instead of parsing terminal
      // text. Live sessions only, and strictly best-effort: a failed scrape
      // leaves the fields absent rather than failing the request.
      if (this.ptyManager.hasSession(sessionId)) {
        try {
          const lines = await this.ptyManager.getOutputLines(sessionId, 10);
          const status = parseStatusLine(lines);
          // Don't clobber the scanner-provided model with a scraped one.
          if (session.model == null && status.model) session.model = status.model;
          if (status.effort) session.effort = status.effort;
          if (status.permissionMode) session.permissionMode = status.permissionMode;
        } catch {
          // PTY raced away between hasSession() and the read — report what we have.
        }
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

  async handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    // Accept both sessionId (new) and conversationId (legacy alias)
    const sessionId: string | undefined = body.sessionId ?? body.conversationId;

    if (!sessionId) {
      json(res, 400, { error: "Missing sessionId" });
      return;
    }

    const outcome = await this.resumeSession({
      sessionId,
      force: body.force === true,
      projectName: body.projectName,
      branch: body.branch,
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case "history_file_missing":
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
        case "no_project_path":
          json(res, 400, { error: "Could not determine project path" });
          return;
        case "conversation_busy":
          json(res, 409, {
            error: "This conversation looks active in another session",
            code: "CONVERSATION_BUSY",
            detectedBy: outcome.detectedBy,
            lastActivityMs: outcome.lastActivityMs,
            likelyOwner: outcome.likelyOwner,
            // Additive capability hints (see docs/compatibility/tb-mobile.md).
            // Older clients ignore them and keep deriving the same actions from
            // `likelyOwner`; newer ones must honour these instead of guessing.
            canForce: true,
            canTakeOver: outcome.likelyOwner === "external",
            canFork: false,
          });
          return;
        case "codex_session_active":
          json(res, 409, codexSessionActiveBody(outcome));
          return;
        case "codex_start_failed":
          json(res, 502, {
            error: outcome.failureReason,
            code: "SESSION_START_FAILED",
            provider: CODEX_CLI_PROVIDER,
          });
          return;
      }
    }

    // Already ours: answer 200 rather than 201, and broadcast nothing — the
    // session list did not change.
    if (outcome.alreadyRunning) {
      json(res, 200, outcome.response);
      return;
    }

    this.deps.broadcastOrUnicastSessionList(req);
    json(res, 201, outcome.response ?? outcome.session);
  }

  /**
   * `POST /api/sessions/:id/fork` — continue a conversation this streamer is
   * not allowed to resume, without touching whoever owns it.
   *
   * Codex only (`codex fork <id>`): Claude Code has no equivalent, and there is
   * no safe generic fallback — quietly resuming instead would attach to the
   * exact writer the caller is trying to leave alone, which is the failure this
   * endpoint exists to avoid.
   *
   * NOT idempotent by default: every accepted call starts another Codex
   * process and another rollout. Clients that retry on timeout must send
   * `idempotencyKey`, which replays the first outcome for 10 minutes (same
   * store and semantics as `POST /:id/input`).
   */
  async handleFork(sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);

    let idempotencyKey: string | undefined;
    try {
      idempotencyKey = readIdempotencyKey(body as Record<string, unknown>);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : "Invalid idempotencyKey" });
      return;
    }
    if (idempotencyKey) {
      const replayed = this.idempotency.get(sessionId, idempotencyKey);
      if (replayed) {
        json(res, replayed.status, replayed.body);
        return;
      }
    }

    const target = await this.deps.resolveConversationTarget(sessionId);
    if (!target.ok) {
      if (target.reason === "history_file_missing") {
        json(res, 404, {
          error: "Conversation history file is missing; it can no longer be forked",
          code: "history_file_missing",
        });
      } else {
        json(res, 400, { error: "Could not determine project path" });
      }
      return;
    }
    if (target.provider !== CODEX_CLI_PROVIDER) {
      json(res, 501, {
        error: "Forking is only supported for Codex sessions",
        code: "UNSUPPORTED_PROVIDER",
        provider: target.provider,
      });
      return;
    }

    this.discoveryCache = null;

    let session: ManagedSession;
    try {
      session = await this.ptyManager.startFork({
        provider: CODEX_CLI_PROVIDER,
        // The rollout id, never the placeholder the client navigated to — it is
        // the only id `codex fork` accepts.
        forkFromId: target.historyId,
        projectPath: target.projectPath,
        projectName: body.projectName,
        branch: body.branch,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fork session";
      const statusCode =
        typeof (err as Error & { statusCode?: unknown }).statusCode === "number"
          ? (err as Error & { statusCode: number }).statusCode
          : 500;
      this.log.error(`[fork] failed to fork ${sessionId}: ${message}`, {
        event: "session.fork_failed",
        sessionId,
        error: message,
      });
      json(res, statusCode, { error: message, code: "FORK_FAILED" });
      return;
    }

    // The fork's own id is a placeholder until Codex writes its rollout; the
    // source id is recorded separately and deliberately never written into
    // `resumedFromConversationId` — the two histories diverge here.
    session.forkedFromConversationId = target.historyId;
    this.sessionStore.addManaged(session);
    this.registryBoot.recordSessionSpawn(session);

    const { outcome, session: settled } = await this.deps.waitForStartupOutcome(
      session.id,
      resolveCodexStartupTimeoutMs(),
    );
    if (outcome === "failed") {
      const failed = settled ?? this.sessionStore.getManaged(session.id);
      this.deps.abandonFailedStart(session.id);
      if (failed?.failureCode === CODEX_ACTIVE_WRITER_CODE) {
        // Rare but real: Codex can refuse a fork too (e.g. the source rollout
        // is mid-write). Same structured collision the resume path returns.
        json(res, 409, codexSessionActiveBody({ detectedBy: [], lastActivityMs: null }));
        return;
      }
      json(res, 502, {
        error: failed?.failureReason ?? "Codex exited before the fork became ready",
        code: "SESSION_START_FAILED",
        provider: CODEX_CLI_PROVIDER,
      });
      return;
    }

    // Bind the NEW rollout id. The candidate filter requires a session_meta
    // created at/after this session started, so it can never re-bind the source.
    this.sessionWatchers.watchForCodexRollout(session.id, target.projectPath);

    const response = this.sessionStore.get(session.id, this.deps.ptyAttachedIds());
    const result = {
      status: outcome === "ready" ? 201 : 202,
      body:
        outcome === "ready"
          ? (response ?? session)
          : { id: session.id, status: "pending", forkedFromConversationId: target.historyId },
    };
    if (idempotencyKey) this.idempotency.set(sessionId, idempotencyKey, result);

    this.log.info(`[fork] forked ${target.historyId} into ${session.id}`, {
      event: "session.forked",
      sessionId: session.id,
      forkedFromConversationId: target.historyId,
      outcome,
    });
    this.deps.broadcastOrUnicastSessionList(req);
    json(res, result.status, result.body);
  }

  /**
   * Resume a session, from an HTTP request or from the boot path.
   *
   * Extracted from `handleResume` so both callers hit the **same collision
   * probe** (plan Phase 7c). The probe is what stops this streamer attaching to
   * a conversation an external terminal already owns; a second, hand-adapted
   * copy of this sequence in the boot path is how two agents end up appending
   * to one JSONL at 4am with nobody watching.
   *
   * Returns a typed reason rather than writing a response, so the HTTP caller
   * maps it to a status code and the boot caller logs it.
   */
  async resumeSession(opts: {
    sessionId: string;
    force?: boolean;
    projectName?: string;
    branch?: string;
  }): Promise<ResumeOutcome> {
    const { sessionId } = opts;

    // If a PTY is already running for this session, return it immediately
    if (this.ptyManager.hasSession(sessionId)) {
      const resp = this.sessionStore.get(sessionId, this.deps.ptyAttachedIds());
      if (resp) {
        return { ok: true, alreadyRunning: true, session: null, response: resp };
      }
    }

    const target = await this.deps.resolveConversationTarget(sessionId);
    if (!target.ok) return target;
    const { historyId, jsonlPath, historyPath, conv, projectPath, provider } = target;

    // Codex-only fast path: does another process hold this exact rollout open?
    // The generic probe below cannot answer that — a Codex owner need not carry
    // the rollout id in argv, and an owned rollout can sit quiet well past the
    // mtime window (the 2026-08-09 incident). An open handle is the same
    // condition Codex's own writer lock rejects, so this is treated as
    // authoritative and `force` does NOT bypass it: forcing would spawn a PTY
    // that Codex refuses anyway, and answer 201 for a session that will never
    // become usable. Fork is the recovery path, not force.
    if (provider === CODEX_CLI_PROVIDER && historyPath) {
      const owner = await findRolloutOwner(historyPath);
      if (owner) {
        this.log.info(`[resume] codex rollout held by pid ${owner.pid}`, {
          event: "session.codex_rollout_busy",
          sessionId,
          historyId,
          ownerPid: owner.pid,
          ownerCommand: owner.command,
        });
        return {
          ok: false,
          reason: "codex_session_active",
          detectedBy: ["file_handle"],
          lastActivityMs: null,
          ownerPid: owner.pid,
          ownerSource: owner.source,
        };
      }
    }

    // Pre-flight collision check: refuse to resume a conversation that looks
    // actively owned elsewhere, unless the caller forces it. Runs AFTER the
    // hasSession early-return above (a session this streamer already owns still
    // returns 200). NOTE: this is a one-directional pre-flight guard only —
    // once this streamer holds the PTY it cannot prevent an external terminal
    // from attaching to the same conversation afterwards.
    // Process enumeration is SLOW on Windows (one CIM/wmic query per candidate
    // pid, seconds when several CLIs are open) and resume is latency-sensitive —
    // the user is waiting on a spawn. Bound it: past the deadline we proceed
    // with no process signals rather than making every resume pay the worst
    // case. jsonl_mtime is the primary signal and is a single stat, so the probe
    // stays useful even when discovery is dropped.
    let discovered: DiscoveredProcess[] = [];
    // Prefer the list GET /api/sessions already keeps warm (15s TTL), including
    // any in-flight refresh — a slightly stale process list is fine for a
    // heuristic pre-flight check, and mobile polls sessions often enough that
    // this is usually a free hit. Bound the wait: past the deadline we proceed
    // with no process signals rather than making every resume pay the worst
    // case. jsonl_mtime is the primary signal and is a single stat, so the probe
    // stays useful even when discovery is dropped.
    try {
      discovered = await Promise.race([
        this.refreshDiscovery(),
        new Promise<DiscoveredProcess[]>((resolve) =>
          setTimeout(() => resolve([]), RESUME_DISCOVERY_TIMEOUT_MS).unref?.(),
        ),
      ]);
    } catch {
      // Discovery is best-effort; the jsonl_mtime signal still applies.
    }
    const busy = conversationBusy({
      // The id another owner's argv would actually carry — for a placeholder
      // that is the bound rollout id, not the one the client asked for.
      conversationId: historyId,
      projectPath,
      jsonlPath,
      discovered,
      windowMs: resolveResumeBusyWindowMs(),
      selfPtyEndedAt: this.selfPtyEndedAt.get(sessionId) ?? null,
    });
    if (busy.busy && opts.force !== true) {
      return {
        ok: false,
        reason: "conversation_busy",
        detectedBy: busy.detectedBy,
        lastActivityMs: busy.lastActivityMs,
        likelyOwner: busy.likelyOwner,
      };
    }
    if (busy.busy) {
      // Forced past a detected collision — mark the session so JSONL-derived
      // question cards from the shared file are suppressed (they may be authored
      // by the other owner). Cleared when the PTY settles to idle.
      this.contendedSessions.add(sessionId);
    }

    // We are about to change what is running, so the discovered-process snapshot
    // is now stale — drop it so the next sessions list re-enumerates. Done AFTER
    // the collision probe, which wants the warm list (a fresh enumeration there
    // costs seconds of wmic on Windows and resume is latency-sensitive).
    this.discoveryCache = null;

    const session = await this.ptyManager.start(sessionId, {
      provider,
      projectPath,
      projectName: opts.projectName,
      branch: opts.branch,
      // Omitted on every ordinary resume, so argv is unchanged there.
      ...(historyId !== sessionId && { resumeId: historyId }),
      claudeFlags: this.claudeFlags,
      claudeExtraArgs: this.claudeExtraArgs,
      ...this.deps.spawnFlagOverrides(),
    });
    // Carry the binding onto the live session before it is recorded:
    // recordSpawn writes `bound_conversation_id` from this field, so leaving it
    // unset would upsert the row back to NULL and strand the *next* resume.
    if (historyId !== sessionId) session.boundConversationId = historyId;

    this.sessionStore.addManaged(session);
    this.registryBoot.recordSessionSpawn(session);

    // Codex is the only authority on its writer lock, and it reports the
    // refusal AFTER the process starts. Spawning is therefore not evidence of a
    // successful resume: wait for a bounded ready-or-failed outcome before
    // telling the caller this worked. Claude's resume is unchanged — it has no
    // equivalent lock, and its collision guard is entirely pre-spawn.
    if (provider === CODEX_CLI_PROVIDER) {
      const { outcome, session: settled } = await this.deps.waitForStartupOutcome(
        sessionId,
        resolveCodexStartupTimeoutMs(),
      );
      if (outcome === "failed") {
        const failed = settled ?? this.sessionStore.getManaged(sessionId);
        this.deps.abandonFailedStart(sessionId);
        if (failed?.failureCode === CODEX_ACTIVE_WRITER_CODE) {
          return {
            ok: false,
            reason: "codex_session_active",
            detectedBy: [],
            lastActivityMs: null,
          };
        }
        return {
          ok: false,
          reason: "codex_start_failed",
          failureReason: failed?.failureReason ?? "Codex exited before becoming ready",
        };
      }
    }

    // Watch the conversation's JSONL file for structured events
    void this.sessionWatchers.watchConversationFile(sessionId, historyId);

    // Enrich session metadata and update DB (best-effort bookkeeping; the
    // conversation history is already in the JSONL). Now runs just before the
    // caller writes its response rather than just after — it is a couple of
    // local SQLite reads, on a path whose latency budget was set by seconds of
    // Windows process enumeration, so the move is not measurable.
    this.deps.enrichResumedSessionAsync(sessionId, projectPath, conv);

    // Read AFTER enrichment: it writes to the store, so the 201 body carries
    // sessionName/projectId/message metadata instead of the bare spawn shape.
    const response = this.sessionStore.get(session.id, this.deps.ptyAttachedIds());

    return { ok: true, alreadyRunning: false, session, response };
  }

  async handleSendInput(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.deps.checkSessionInputRateLimit(sessionId)) {
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

    // Idempotency (C4). A retry — flaky network, double-tap, client resend on
    // timeout — must not submit the same prompt to the agent twice. Checked
    // before ANY write so a replay never reaches the PTY.
    let idempotencyKey: string | undefined;
    try {
      idempotencyKey = readIdempotencyKey(body as Record<string, unknown>);
    } catch (err) {
      // A client that sent a malformed key believes it has retry protection;
      // proceeding without it silently would be worse than rejecting.
      json(res, 400, { error: err instanceof Error ? err.message : "Invalid idempotencyKey" });
      return;
    }
    if (idempotencyKey) {
      const replayed = this.idempotency.get(sessionId, idempotencyKey);
      if (replayed) {
        this.log.info(`[input.replay] ${sessionId.slice(0, 8)} duplicate idempotencyKey`, {
          event: "input.idempotent_replay",
          sessionId,
        });
        json(res, replayed.status, replayed.body);
        return;
      }
    }

    if (typeof keys === "string") {
      // Raw key bytes (e.g. arrow navigation for interactive prompts).
      // These bypass bracketed-paste wrapping — caller is responsible for
      // sending well-formed escape sequences.
      try {
        this.ptyManager.sendKeys(sessionId, keys);
        const updated = this.sessionStore.get(sessionId, this.deps.ptyAttachedIds());
        if (updated) {
          this.wsHub.broadcast({ type: "session_update", session: updated });
        }
        const result = { status: 200, body: { ok: true } };
        if (idempotencyKey) this.idempotency.set(sessionId, idempotencyKey, result);
        json(res, result.status, result.body);
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
      const updated = this.sessionStore.get(sessionId, this.deps.ptyAttachedIds());
      if (updated) {
        this.wsHub.broadcast({ type: "session_update", session: updated });
      }
      // Index the user's new message immediately so it's searchable right away.
      const filePath = this.sessionFileMap.get(sessionId);
      if (filePath) {
        this.scannerManager
          .get()
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
      const result = { status: 200, body: { ok: true } };
      // Record only on success: a failed write must stay retryable, otherwise a
      // transient error would be replayed as a permanent one.
      if (idempotencyKey) this.idempotency.set(sessionId, idempotencyKey, result);
      json(res, result.status, result.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send input";
      json(res, 400, { error: message });
    }
  }

  // Live AskUserQuestion detected from the rendered screen (ahead of JSONL).
  // Broadcasts the `question` event immediately and records the content key so
  // the later JSONL flush of the same question is de-duped. We synthesize a
  // screen-scoped toolUseId; the JSONL path overwrites pendingQuestions with the
  // real toolUseId when it lands, so answering works once JSONL catches up.
  handleLiveQuestion(sessionId: string, questions: AskQuestion[]): void {
    const key = questionContentKey(questions);
    if (this.pendingQuestionKey.get(sessionId) === key) return; // already shown
    const toolUseId = `screen:${sessionId}:${key.length}`;
    this.pendingQuestions.set(sessionId, { toolUseId, questions, origin: "pty" });
    this.pendingQuestionKey.set(sessionId, key);
    this.wsHub.broadcast({ type: "question", sessionId, toolUseId, questions });
  }

  // Permission gate opened/closed (OSC 777 + scraped options). Broadcasts the
  // additive `permission` / `permission_cancelled` events. Mobile answers by
  // sending the chosen option index via /input { keys } (e.g. "2\r").
  handlePermissionChange(
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
      this.pendingPermissionKey.delete(sessionId);
      this.wsHub.broadcast({ type: "permission_cancelled", sessionId });
      return;
    }
    const key = permissionContentKey(gate);
    if (this.pendingPermissionKey.get(sessionId) === key) return; // unchanged repaint
    this.pendingPermission.set(sessionId, gate);
    this.pendingPermissionKey.set(sessionId, key);
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

  async handleSendAnswer(
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

  async handleUploadFile(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const session = this.sessionStore.get(sessionId, this.deps.ptyAttachedIds());
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

  handleGetOutput(sessionId: string, res: ServerResponse): void {
    // Return PTY ring buffer if a PTY is attached; otherwise return empty
    // so clients render "no buffered output" instead of an error.
    try {
      const output = this.ptyManager.getOutput(sessionId);
      json(res, 200, { output });
    } catch {
      json(res, 200, { output: "" });
    }
  }

  handleCancel(sessionId: string, res: ServerResponse): void {
    this.discoveryCache = null;
    try {
      this.ptyManager.cancel(sessionId);
      json(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to cancel";
      json(res, 400, { error: message });
    }
  }

  async handleStopSession(sessionId: string, res: ServerResponse): Promise<void> {
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

  async handleAdopt(sessionId: string, res: ServerResponse): Promise<void> {
    // Refresh discovery so we have the latest metadata
    const discovered = await discoverClaudeProcesses();
    this.sessionStore.setDiscovered(discovered);
    this.discoveryCache = null;

    const discSession = this.sessionStore.get(sessionId, this.deps.ptyAttachedIds());
    if (!discSession || discSession.ptyAttached) {
      json(res, 404, { error: "Discovered session not found" });
      return;
    }

    const { branch } = discSession;
    let { projectPath, projectName } = discSession;
    const convId = discSession.id;

    if (discSession.pid == null) {
      json(res, 400, { error: "Session has no known PID" });
      return;
    }

    // Windows exposes no process CWD (neither CIM nor wmic carries it), so
    // discovery reports an empty projectPath rather than fabricating one. Fall
    // back to the conversation's own JSONL — the same authoritative source
    // handleResume uses, since it is the file Claude looks up by filename when
    // processing --resume. Every session reaching adopt has a conversation id
    // (SessionStore drops discovered processes without one), so this resolves
    // in the normal case on every platform.
    if (!projectPath) {
      const jsonlPath = this.deps.findJsonlPath(convId);
      const jsonlCwd = jsonlPath ? await this.deps.readCwdFromJsonl(jsonlPath) : null;
      if (jsonlCwd) {
        projectPath = jsonlCwd;
        projectName = projectName || basename(jsonlCwd);
      }
    }

    // Refuse BEFORE killing anything if we could not resolve where the process
    // is running. Adopt is destructive-then-restorative, so every reason it
    // cannot restore has to be checked first: spawning the replacement with an
    // empty cwd fails outright, and killing first then discovering this would
    // destroy the user's session with nothing to put back in its place.
    if (!projectPath) {
      this.log.warn("adopt: refusing, working directory unknown", {
        event: "adopt.no_project_path",
        sessionId,
        pid: discSession.pid,
      });
      json(res, 400, {
        error:
          "Cannot take over this session: its working directory could not be determined on this platform",
        code: "ADOPT_NO_PROJECT_PATH",
      });
      return;
    }

    // Same reasoning one step further: a conversation whose project directory
    // was deleted (or whose worktree was removed) cannot be respawned there, so
    // refuse while the external session is still alive rather than killing it
    // and failing on spawn.
    const availability = classifyResumability(projectPath);
    if (!availability.resumable) {
      this.log.warn("adopt: refusing, project directory no longer exists", {
        event: "adopt.project_path_missing",
        sessionId,
        pid: discSession.pid,
        projectPath,
        reason: availability.unavailable_reason,
      });
      json(res, 400, {
        error: "Cannot take over this session: its project directory no longer exists",
        code: "ADOPT_PROJECT_PATH_MISSING",
        reason: availability.unavailable_reason,
      });
      return;
    }

    // Kill the external process and WAIT for it to actually go. SIGTERM is
    // asynchronous: spawning `claude --resume` on the same conversation before
    // the old process is gone leaves two agents appending to one JSONL — the
    // interleaved-transcript state this codebase has no way to repair. If it
    // outlives the grace period we abort rather than knowingly create that.
    this.ptyManager.killPid(discSession.pid);
    const exited = await waitForProcessExit(discSession.pid, ADOPT_KILL_TIMEOUT_MS);
    if (!exited) {
      this.log.warn("adopt: external process did not exit; refusing to double-write", {
        event: "adopt.kill_timeout",
        sessionId,
        pid: discSession.pid,
      });
      json(res, 409, {
        error:
          "The existing process did not exit; not starting a second agent on this conversation",
        code: "ADOPT_KILL_TIMEOUT",
        pid: discSession.pid,
      });
      return;
    }

    // Start a new managed session, resuming the conversation
    const session = await this.ptyManager.start(convId, {
      projectPath,
      projectName,
      branch,
      claudeFlags: this.claudeFlags,
      claudeExtraArgs: this.claudeExtraArgs,
      ...this.deps.spawnFlagOverrides(),
    });

    this.sessionStore.addManaged(session);
    this.registryBoot.recordSessionSpawn(session);
    void this.sessionWatchers.watchConversationFile(session.id);

    this.wsHub.broadcast({
      type: "session_list",
      sessions: this.sessionStore.list(this.deps.ptyAttachedIds()),
    });

    json(res, 201, { sessionId: session.id });
  }

  async handleStartSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket?.remoteAddress ?? "unknown";
    if (!this.deps.checkSessionStartRateLimit(ip)) {
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
        this.deps.broadcastOrUnicastSessionList(req);
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

    // Codex has no --system-prompt flag — sending one is a positional
    // [PROMPT] arg that Codex treats as the opening turn, not a system-level
    // instruction. Gate it behind codexSystemPromptEnabled so a fresh Codex
    // session never gets an uninvited first message unless opted in.
    const includeSystemPrompt = provider !== CODEX_CLI_PROVIDER || this.codexSystemPromptEnabled;

    try {
      const session = await this.ptyManager.startFresh({
        provider,
        projectPath: resolvedPath,
        projectName: body.projectName,
        ...(includeSystemPrompt && { systemPrompt: systemPromptParts.join("\n") }),
        claudeFlags: this.claudeFlags,
        claudeExtraArgs: this.claudeExtraArgs,
        ...this.deps.spawnFlagOverrides(),
      });

      this.sessionStore.addManaged(session);
      this.registryBoot.recordSessionSpawn(session);

      // Block for the PTY to actually reach waiting_input (or fail) so the
      // caller gets a trustworthy status instead of navigating on a guess.
      // Races against the same fallback window pty-manager itself uses for
      // prompt-marker detection, plus margin — if neither settles in time we
      // fall back to the old fire-and-forget shape rather than hang the request.
      const { outcome } = await this.deps.waitForStartupOutcome(session.id, START_READY_TIMEOUT_MS);
      const current = this.sessionStore.get(session.id, this.deps.ptyAttachedIds());

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
        this.sessionWatchers.watchForCodexRollout(session.id, resolvedPath);
      } else {
        // Wire up JSONL watching once Claude creates the conversation file.
        this.sessionWatchers.watchForJsonl(session.id, resolvedPath);
      }

      this.deps.broadcastOrUnicastSessionList(req);
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

  async handleSetSessionName(
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

  handleGetSessionNames(res: ServerResponse): void {
    if (!this.cache) {
      json(res, 200, {});
      return;
    }
    json(res, 200, this.cache.listSessionNames());
  }
}
