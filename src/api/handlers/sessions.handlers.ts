import { randomUUID } from "crypto";
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
import { PTY_ROWS } from "../../pty-shared";
import type { ScannerManager } from "../../scanner-manager";
import { type Prompt, PromptAnswerSchema } from "../../schemas/prompt.schema";
import type { ResumeFailure, ResumeOutcome } from "../../server";
import type { PendingPermission, PendingQuestion } from "../../server-wiring";
import {
  type PromptAdapterResult,
  type PromptAnswerAdapter,
  type PromptAnswerErrorCode,
  PromptRegistry,
} from "../../services/prompts/promptRegistry";
import {
  permissionPromptDraft,
  questionPromptDraft,
} from "../../services/prompts/ptyPromptAdapter";
import { CODEX_ACTIVE_WRITER_CODE } from "../../services/questions/codexScreen";
import {
  permissionContentKey,
  permissionGateKey,
  scrapePermissionGate,
} from "../../services/questions/detectPermissionGate";
import {
  isQuestionMenuOnScreen,
  questionContentKey,
} from "../../services/questions/detectQuestionFromScreen";
import { parseStatusLine } from "../../services/questions/parseStatusLine";
import { permissionAnswerKeys } from "../../services/questions/permissionAnswerKeys";
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
  WSMessage,
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
 * Prompt-answer taxonomy to HTTP status.
 *
 * The validation class is 400, matching what the legacy `/answer` route already
 * returns for the same "this answer cannot be applied to this prompt" family;
 * the state class — the prompt moved on, or never existed here — is 409/404.
 */
function promptAnswerStatus(code: PromptAnswerErrorCode): number {
  switch (code) {
    case "prompt_not_found":
      return 404;
    case "provider_error":
      return 502;
    case "unknown_question":
    case "unknown_option":
    case "incomplete_answer":
    case "unsupported_prompt_shape":
      return 400;
    default:
      return 409;
  }
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
  promptRegistry: PromptRegistry;
  pendingQuestions: Map<string, PendingQuestion>;
  pendingQuestionKey: Map<string, string>;
  pendingPermission: Map<string, PendingPermission>;
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
  forgetSession: (sessionId: string) => void;
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

  private get promptRegistry(): PromptRegistry {
    if (!this.deps.promptRegistry) this.deps.promptRegistry = new PromptRegistry();
    return this.deps.promptRegistry;
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

  // Prompt lifecycle events (question / permission and their cancellations)
  // carry prompt content and go ONLY to the session's subscribers — never to
  // every connected socket. A client that subscribes after a prompt opened
  // gets it from the subscribe replay (server-wiring), not from a broadcast.
  private broadcastToSession(sessionId: string, message: WSMessage): void {
    this.wsHub.broadcastToClients(this.sessionSubscribers.get(sessionId) ?? [], message);
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

    // Semantic input arbitration. While a permission gate or AskUserQuestion
    // menu is up, the PTY's cursor is on the picker, so composer text would
    // commit the highlighted option (live capture: prose typed over an open
    // card approved a tool call). Refuse before ANY write. `{ keys }` above is
    // deliberately not arbitrated — Esc and arrow nav are how a card is
    // dismissed or navigated. The pending maps are the same authority the
    // answer routes use; no screen re-scrape here, because the Claude scraper
    // would fail open on Codex's synthesized gates. Not recorded in
    // idempotency: a resend of the same key after the card is answered must go
    // through, not replay this refusal.
    //
    // Sweeps expired prompts so their onExpire clears the pending maps before the read below.
    this.promptRegistry.sweepExpired(sessionId);
    const openPrompt = this.pendingPermission.has(sessionId)
      ? "permission"
      : this.pendingQuestions.has(sessionId)
        ? "question"
        : null;
    if (openPrompt) {
      // An accepted permission answer writes the keys and resolves the prompt record, but the
      // entry lives on until the detector sees the gate repaint away. Text in that window is
      // still refused — the cursor may still be on the picker — yet "answer the prompt" is the
      // wrong thing to tell someone who just answered it. `resolved` is the only registry state
      // that means the keys were written: a refused answer leaves a `cancelled` record beside a
      // live entry and must keep reading "open". Questions never reach here answered, because
      // both accept paths delete `pendingQuestions` before returning.
      const pendingGate =
        openPrompt === "permission" ? this.pendingPermission.get(sessionId) : undefined;
      const promptState =
        pendingGate?.promptId !== undefined &&
        this.promptRegistry.get(pendingGate.promptId)?.state === "resolved"
          ? "answered"
          : "open";
      this.log.info(
        `[input.prompt_pending] ${sessionId.slice(0, 8)} kind=${openPrompt} state=${promptState}`,
        {
          event: "input.prompt_pending",
          sessionId,
          promptKind: openPrompt,
          promptState,
        },
      );
      json(res, 409, {
        ok: false,
        reason: "prompt_pending",
        promptKind: openPrompt,
        promptState,
        error:
          promptState === "answered"
            ? "Your answer was sent; wait for the prompt to close before sending text"
            : "A prompt is waiting for an answer; answer or dismiss it before sending text",
      });
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
  handleLiveQuestion(sessionId: string, questions: AskQuestion[], occurrenceId?: string): void {
    const key = questionContentKey(questions);
    if (this.pendingQuestionKey.get(sessionId) === key) return; // already shown
    const toolUseId = `screen:${sessionId}:${key.length}`;
    const prior = this.pendingQuestions.get(sessionId);
    const priorPrompt = prior ? this.promptRegistry.get(prior.promptId) : null;
    if (priorPrompt?.state === "open" || priorPrompt?.state === "updated") {
      this.promptRegistry.transition(priorPrompt.promptId, "cancelled", "replaced");
    }
    const prompt = this.promptRegistry.open(
      questionPromptDraft(sessionId, questions, "screen"),
      this.questionAnswerAdapter(sessionId),
      occurrenceId,
    );
    this.pendingQuestions.set(sessionId, {
      toolUseId,
      questions,
      origin: "pty",
      promptId: prompt.promptId,
    });
    this.pendingQuestionKey.set(sessionId, key);
    this.broadcastToSession(sessionId, { type: "question", sessionId, toolUseId, questions });
  }

  handleJsonlQuestion(
    sessionId: string,
    toolUseId: string,
    questions: AskQuestion[],
    origin: "pty" | "jsonl",
  ): void {
    const prior = this.pendingQuestions.get(sessionId);
    const sameQuestion =
      prior !== undefined && questionContentKey(prior.questions) === questionContentKey(questions);
    let prompt: Prompt;
    if (sameQuestion) {
      const current = this.promptRegistry.get(prior.promptId);
      prompt =
        current?.provenance.source === "transcript"
          ? current
          : this.promptRegistry.update(
              prior.promptId,
              questionPromptDraft(sessionId, questions, "transcript"),
              this.questionAnswerAdapter(sessionId),
            );
    } else {
      const priorPrompt = prior ? this.promptRegistry.get(prior.promptId) : null;
      if (priorPrompt?.state === "open" || priorPrompt?.state === "updated") {
        this.promptRegistry.transition(priorPrompt.promptId, "cancelled", "replaced");
      }
      prompt = this.promptRegistry.open(
        questionPromptDraft(sessionId, questions, "transcript"),
        this.questionAnswerAdapter(sessionId),
      );
    }
    this.pendingQuestions.set(sessionId, {
      toolUseId,
      questions,
      origin,
      promptId: prompt.promptId,
    });
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
    occurrenceId?: string,
  ): void {
    if (gate === null) {
      const prior = this.pendingPermission.get(sessionId);
      if (!prior) return;
      const prompt = prior.promptId ? this.promptRegistry.get(prior.promptId) : null;
      if (prompt?.state === "open" || prompt?.state === "updated") {
        this.promptRegistry.transition(prompt.promptId, "cancelled", "provider_closed");
      }
      this.pendingPermission.delete(sessionId);
      this.pendingPermissionKey.delete(sessionId);
      this.broadcastToSession(sessionId, { type: "permission_cancelled", sessionId });
      return;
    }
    const key = permissionContentKey(gate);
    const prior = this.pendingPermission.get(sessionId);
    const priorPromptId = prior?.promptId;
    if (
      this.pendingPermissionKey.get(sessionId) === key &&
      (occurrenceId === undefined || prior?.occurrenceId === occurrenceId)
    ) {
      return; // unchanged repaint
    }
    // Server-owned instance id. permissionGateKey is content-derived and cannot
    // tell two consecutive identical gates apart; this can. The same identity
    // as the pending gate (cursor moved, repaint) keeps its id; anything else —
    // first open, different content, reopen after a close — is a new instance.
    //
    // Occurrence is compared to OCCURRENCE, never to promptId. The two were
    // equal by construction until open() began minting a fresh id for a
    // replayed occurrence held by a terminal record: after such a reopen the
    // entry carries the new id while the host still sends the original
    // occurrence (host.ts keeps it while permissionGateKey is unchanged, and
    // that key excludes the cursor), so comparing against promptId made every
    // later repaint a new instance — a cancel+open pair per paint, a new
    // gateId on the wire, and any in-flight answer settling prompt_cancelled.
    // `priorPromptId !== undefined` stays: it guards the registry lookup
    // below, which is a separate question from identity.
    const samePrompt =
      prior &&
      priorPromptId !== undefined &&
      permissionGateKey(prior) === permissionGateKey(gate) &&
      (occurrenceId === undefined || prior.occurrenceId === occurrenceId);
    if (prior && !samePrompt) {
      const priorPrompt = prior.promptId ? this.promptRegistry.get(prior.promptId) : null;
      if (priorPrompt?.state === "open" || priorPrompt?.state === "updated") {
        this.promptRegistry.transition(priorPrompt.promptId, "cancelled", "replaced");
      }
    }
    const prompt =
      gate.options.length === 0
        ? null
        : samePrompt
          ? this.promptRegistry.get(priorPromptId)
          : this.promptRegistry.open(
              permissionPromptDraft(sessionId, gate),
              this.permissionAnswerAdapter(sessionId),
              occurrenceId,
            );
    if (samePrompt && !prompt) throw new Error("Pending permission prompt disappeared");
    const gateId = prompt?.promptId ?? occurrenceId ?? prior?.gateId ?? randomUUID();
    this.pendingPermission.set(sessionId, {
      ...gate,
      gateId,
      ...(prompt ? { promptId: prompt.promptId } : {}),
      ...(occurrenceId !== undefined ? { occurrenceId } : {}),
    });
    this.pendingPermissionKey.set(sessionId, key);
    const subscriberCount = this.sessionSubscribers.get(sessionId)?.size ?? 0;
    this.log.info(
      `[ws.broadcast_permission] ${sessionId.slice(0, 8)} subscribers=${subscriberCount}`,
      { event: "ws.broadcast_permission", sessionId, subscriberCount },
    );
    this.broadcastToSession(sessionId, {
      type: "permission",
      sessionId,
      ...(gate.prompt ? { prompt: gate.prompt } : {}),
      ...(gate.detail ? { detail: gate.detail } : {}),
      options: gate.options,
      ...(gate.cursor !== undefined ? { cursor: gate.cursor } : {}),
      contentKey: permissionGateKey(gate),
      gateId,
    });
  }

  private permissionAnswerAdapter(sessionId: string): PromptAnswerAdapter {
    return async ({ prompt, answer }): Promise<PromptAdapterResult> => {
      const gate = this.pendingPermission.get(sessionId);
      if (!gate || gate.promptId !== prompt.promptId) {
        return {
          ok: false,
          code: "prompt_unavailable",
          terminal: { state: "unavailable", reason: "provider_prompt_missing" },
        };
      }
      const response = answer.responses[0];
      const selectedId = response?.optionIds?.[0];
      const selectedIndex = prompt.questions[0]?.options.findIndex(
        (option) => option.optionId === selectedId,
      );
      if (selectedIndex === undefined || selectedIndex < 0) {
        return { ok: false, code: "unknown_option" };
      }
      const option = gate.options[selectedIndex];
      if (!option) return { ok: false, code: "unknown_option" };
      const provider = this.sessionStore.getManaged(sessionId)?.provider;
      if (
        provider !== CODEX_CLI_PROVIDER &&
        !(await this.permissionGateStillOpen(sessionId, permissionGateKey(gate)))
      ) {
        return {
          ok: false,
          code: "prompt_cancelled",
          terminal: { state: "cancelled", reason: "provider_closed" },
        };
      }
      if (this.pendingPermission.get(sessionId)?.promptId !== prompt.promptId) {
        return { ok: false, code: "prompt_cancelled" };
      }
      try {
        this.ptyManager.sendKeys(
          sessionId,
          option.answerKeys ?? permissionAnswerKeys(option.index),
        );
      } catch {
        return { ok: false, code: "provider_error" };
      }
      return { ok: true };
    };
  }

  private questionAnswerAdapter(sessionId: string): PromptAnswerAdapter {
    return async ({ prompt, answer }): Promise<PromptAdapterResult> => {
      const pending = this.pendingQuestions.get(sessionId);
      if (!pending || pending.promptId !== prompt.promptId) {
        return {
          ok: false,
          code: "prompt_unavailable",
          terminal: { state: "unavailable", reason: "provider_prompt_missing" },
        };
      }
      const answers: Record<string, string | string[]> = {};
      for (const question of prompt.questions) {
        const response = answer.responses.find((item) => item.questionId === question.questionId);
        if (!response?.optionIds) return { ok: false, code: "unsupported_prompt_shape" };
        answers[question.text] = response.optionIds.map((optionId) => {
          const option = question.options.find((item) => item.optionId === optionId);
          return option?.label ?? "";
        });
      }
      const resolution = resolveAnswer(pending, {
        toolUseId: pending.toolUseId,
        answers,
      });
      if (!resolution.ok) {
        const code =
          resolution.reason === "unknown_option" ||
          resolution.reason === "incomplete_answer" ||
          resolution.reason === "unsupported_prompt_shape"
            ? resolution.reason
            : "prompt_unavailable";
        return { ok: false, code };
      }
      if (!(await this.questionMenuStillOpen(sessionId))) {
        this.pendingQuestions.delete(sessionId);
        this.pendingQuestionKey.delete(sessionId);
        this.broadcastToSession(sessionId, {
          type: "question_cancelled",
          sessionId,
          toolUseId: pending.toolUseId,
        });
        return {
          ok: false,
          code: "prompt_cancelled",
          terminal: { state: "cancelled", reason: "provider_closed" },
        };
      }
      if (this.pendingQuestions.get(sessionId)?.promptId !== prompt.promptId) {
        return { ok: false, code: "prompt_cancelled" };
      }
      try {
        this.ptyManager.sendKeys(sessionId, resolution.keys);
      } catch {
        return { ok: false, code: "provider_error" };
      }
      this.pendingQuestions.delete(sessionId);
      this.pendingQuestionKey.delete(sessionId);
      this.broadcastToSession(sessionId, {
        type: "question_cancelled",
        sessionId,
        toolUseId: pending.toolUseId,
      });
      return { ok: true };
    };
  }

  /**
   * Answer a permission gate — the validated counterpart of POST /:id/input.
   *
   * `/input` is a raw-bytes conduit (arrow-key nav uses it too) and stays that
   * way; this route is the semantic one, mirroring the /answer split. Two
   * things make it more than validation theatre:
   *
   *   - The client sends `{ contentKey, optionIndex }` and NO keystrokes. The
   *     keys are derived here from our own copy of the gate, so the client's
   *     key-derivation can never drift from the server's.
   *   - `contentKey` binds the answer to a specific gate. `isPermissionAnswer`
   *     matches structurally, and approval gates repeat constantly ("2. Yes /
   *     3. No" for every tool call), so without this a delayed answer to gate A
   *     could be written as gate B's answer — a user approving a bash command
   *     they never saw, with a 200 and a normal permission_cancelled. Treat the
   *     check as a security boundary.
   *
   * Every refusal happens BEFORE sendKeys. On success we deliberately broadcast
   * nothing: the PTY-side close (isPermissionAnswer in pty-manager) recognises
   * the bytes we just wrote and fires permission_cancelled itself.
   */
  async handlePermissionAnswer(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    const contentKey = body?.contentKey;
    const optionIndex = body?.optionIndex;
    const gateId = body?.gateId;
    if (typeof contentKey !== "string" || !Number.isInteger(optionIndex) || optionIndex < 0) {
      json(res, 400, { ok: false, reason: "Expected { contentKey: string, optionIndex: number }" });
      return;
    }
    if (gateId !== undefined && typeof gateId !== "string") {
      json(res, 400, { ok: false, reason: "Expected gateId to be a string" });
      return;
    }

    // The client's card is dead. Clear it everywhere — permission_cancelled is
    // unconditional here (a no-op for clients showing nothing) because a client
    // that got this far believes a gate is up and must be told it isn't.
    const gateClosed = (): void => {
      const pending = this.pendingPermission.get(sessionId);
      const prompt = pending?.promptId ? this.promptRegistry.get(pending.promptId) : null;
      if (prompt?.state === "open" || prompt?.state === "updated") {
        this.promptRegistry.transition(prompt.promptId, "cancelled", "provider_closed");
      }
      this.pendingPermission.delete(sessionId);
      this.pendingPermissionKey.delete(sessionId);
      this.broadcastToSession(sessionId, { type: "permission_cancelled", sessionId });
      json(res, 409, { ok: false, reason: "gate_closed" });
    };

    // Cheapest first, screen scrape last. Every branch below returns before
    // sendKeys — that ordering is the point of the route.
    const gate = this.pendingPermission.get(sessionId);
    if (!gate) {
      gateClosed();
      return;
    }
    // Instance check. A stale gateId means the client is answering a gate that
    // has since closed and reopened — possibly with identical content, which
    // contentKey alone would wave through. Refuse quietly, exactly like the
    // content mismatch below: the live gate is fine and must stay up.
    if (gateId !== undefined && gateId !== gate.gateId) {
      json(res, 409, { ok: false, reason: "gate_mismatch" });
      return;
    }
    if (gateId === undefined) {
      // Temporary compatibility path for clients that predate gateId. Logged
      // (metadata only) so its use is measurable and the path can be retired.
      this.log.info(`[permission.answer_legacy_identity] ${sessionId.slice(0, 8)}`, {
        event: "permission.answer_legacy_identity",
        sessionId,
      });
    }
    // A DIFFERENT gate is open, and it is legitimately on screen. Refuse, but
    // broadcast nothing: permission_cancelled is session-wide, so it would
    // clear a live card on every client, and the pendingPermissionKey dedupe
    // means the repaint that would restore it may never come — a gate is a
    // waiting screen. The requesting client clears from the reason instead.
    // (Same shape as resolveAnswer's tool_use_mismatch, which also stays quiet.)
    if (permissionGateKey(gate) !== contentKey) {
      json(res, 409, { ok: false, reason: "gate_mismatch" });
      return;
    }
    const option = gate.options[optionIndex];
    if (!option) {
      json(res, 409, { ok: false, reason: "unknown_option" });
      return;
    }
    // Our copy agrees; now ask the screen, which is fresher than the map — for
    // Claude. Codex gates are synthesized by its runner from its own TUI
    // patterns, and the Claude box scraper never matches a Codex screen, so
    // asking it refused every Codex answer as gate_closed. The Codex runner
    // clears the pending gate itself when the dialog leaves the screen, so for
    // Codex the map is the authority and gateId carries instance identity.
    const provider = this.sessionStore.getManaged(sessionId)?.provider;
    if (
      provider !== CODEX_CLI_PROVIDER &&
      !(await this.permissionGateStillOpen(sessionId, contentKey))
    ) {
      gateClosed();
      return;
    }

    try {
      this.ptyManager.sendKeys(sessionId, option.answerKeys ?? permissionAnswerKeys(option.index));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send answer";
      json(res, 400, { ok: false, reason: message });
      return;
    }
    const normalized = gate.promptId ? this.promptRegistry.get(gate.promptId) : null;
    if (normalized?.state === "open" || normalized?.state === "updated") {
      this.promptRegistry.transition(normalized.promptId, "resolved", "answered_legacy");
    }
    json(res, 200, { ok: true });
  }

  /**
   * Is THIS gate still the one on screen?
   *
   * Deliberately stricter than questionMenuStillOpen's "is a menu up": the
   * staleness window this exists to cover (the ~300ms scrape throttle plus the
   * wait for the next PTY chunk) is exactly where pendingPermission still says
   * gate A while the screen has moved to gate B — and since approval gates
   * repeat their shape, "some gate is open" would wave that through.
   *
   * Reads 60 lines because that is the window the detector that produced the
   * pending gate uses (pty-manager's scrape); `detail` walks up to 6 lines
   * above the prompt, so a shorter window can truncate it and manufacture a
   * mismatch on a healthy gate.
   *
   * Best-effort, like questionMenuStillOpen: a session we hold no PTY for, or
   * one that raced away mid-read, is not ours to veto.
   */
  private async permissionGateStillOpen(sessionId: string, contentKey: string): Promise<boolean> {
    if (!this.ptyManager.hasSession(sessionId)) return true;
    try {
      const onScreen = scrapePermissionGate(await this.ptyManager.getOutputLines(sessionId, 60));
      return onScreen !== null && permissionGateKey(onScreen) === contentKey;
    } catch {
      return true;
    }
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
      // Shapes this PTY path cannot answer (multi-question, multi-select, or an
      // answer for a question that was never given) fail closed: nothing is
      // written, and the client is told where the prompt can still be answered.
      const unanswerable =
        resolution.reason === "unsupported_prompt_shape" ||
        resolution.reason === "incomplete_answer";
      json(res, 400, {
        ok: false,
        reason: resolution.reason,
        ...(unanswerable
          ? {
              error:
                "This prompt needs an answer the app cannot give yet; answer it in the terminal",
            }
          : {}),
      });
      return;
    }
    // pending is guaranteed defined when resolution.ok is true (resolveAnswer guards it)
    const toolUseId = pending?.toolUseId ?? "";
    // A menu can close without this route answering it — Esc via /input { keys },
    // an answer typed at the host keyboard, /clear, the model giving up. Nothing
    // clears pendingQuestions in those cases (onLiveQuestionGone has no producer),
    // so the client keeps a live-looking card and these keystrokes would be typed
    // into the prompt box instead of the picker. The rendered screen is the only
    // authority on whether the picker is still up.
    if (!(await this.questionMenuStillOpen(sessionId))) {
      const prompt = this.promptRegistry.get(pending?.promptId ?? "");
      if (prompt?.state === "open" || prompt?.state === "updated") {
        this.promptRegistry.transition(prompt.promptId, "cancelled", "provider_closed");
      }
      this.pendingQuestions.delete(sessionId);
      this.pendingQuestionKey.delete(sessionId);
      this.broadcastToSession(sessionId, { type: "question_cancelled", sessionId, toolUseId });
      json(res, 409, { ok: false, reason: "question_gone" });
      return;
    }
    try {
      this.ptyManager.sendKeys(sessionId, resolution.keys);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send answer";
      json(res, 400, { ok: false, reason: message });
      return;
    }
    const normalized = this.promptRegistry.get(pending?.promptId ?? "");
    if (normalized?.state === "open" || normalized?.state === "updated") {
      this.promptRegistry.transition(normalized.promptId, "resolved", "answered_legacy");
    }
    this.pendingQuestions.delete(sessionId);
    this.broadcastToSession(sessionId, { type: "question_cancelled", sessionId, toolUseId });
    json(res, 200, { ok: true });
  }

  /**
   * Answer a normalized prompt by its opaque ids.
   *
   * Refusals are keyed by `code` — the stable machine taxonomy of the prompt
   * contract. The released legacy routes (`/answer`, `/permission/answer`) key
   * theirs by `reason` and keep doing so; a client reads whichever key belongs
   * to the route it called, and the two vocabularies are not merged.
   *
   * Status follows the same split as the legacy routes: a malformed or
   * unanswerable *request* is 400, a prompt whose *state* refuses the answer is
   * 409. A retry after PROMPT_TERMINAL_RETENTION_MS answers 404
   * `prompt_not_found`, not the recorded outcome — the record it would replay
   * is gone by then.
   */
  async handlePromptAnswer(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const parsed = PromptAnswerSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      json(res, 400, { ok: false, code: "invalid_prompt_answer" });
      return;
    }
    const outcome = await this.promptRegistry.answer(sessionId, parsed.data);
    if (outcome.ok) {
      json(res, 200, outcome);
      return;
    }
    json(res, promptAnswerStatus(outcome.code), outcome);
  }

  // Best-effort: a session we don't own a PTY for, or one that raced away
  // mid-read, is not ours to veto — say yes and let the write decide.
  private async questionMenuStillOpen(sessionId: string): Promise<boolean> {
    if (!this.ptyManager.hasSession(sessionId)) return true;
    try {
      return isQuestionMenuOnScreen(await this.ptyManager.getOutputLines(sessionId, PTY_ROWS));
    } catch {
      return true;
    }
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

    // Capture before putOnHold: the runner deletes the live session on hold,
    // and onStatusChange then writes selfPtyEndedAt / a registry idle row that
    // forgetSession has to clear afterwards.
    const shouldForget = this.shouldForgetEmptySession(session);

    if (session.status === "idle") {
      if (shouldForget) this.forgetEmptyStoppedSession(sessionId);
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

    if (shouldForget) this.forgetEmptyStoppedSession(sessionId);

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

  /**
   * An unused start: the user never submitted a prompt, and the conversation
   * cache has no row for this id (empty Codex/Claude often never write a JSONL).
   * `conversationId === sessionId` is not evidence of history — only the cache
   * is. promptCount > 0 or a cache hit keeps today's hold path.
   */
  private shouldForgetEmptySession(session: ManagedSession): boolean {
    const stored = this.sessionStore.getManaged(session.id);
    const promptCount = Math.max(session.promptCount, stored?.promptCount ?? 0);
    if (promptCount > 0) return false;
    return !this.hasCachedConversationFor(session, stored);
  }

  private hasCachedConversationFor(
    session: ManagedSession,
    stored: ManagedSession | null,
  ): boolean {
    const cache = this.cache;
    if (!cache) return false;
    const ids = new Set<string>([session.id]);
    if (session.boundConversationId) ids.add(session.boundConversationId);
    if (session.resumedFromConversationId) ids.add(session.resumedFromConversationId);
    if (stored?.boundConversationId) ids.add(stored.boundConversationId);
    if (stored?.resumedFromConversationId) ids.add(stored.resumedFromConversationId);
    for (const id of ids) {
      if (cache.hasConversation(id)) return true;
    }
    return false;
  }

  private forgetEmptyStoppedSession(sessionId: string): void {
    this.log.info(`[stop] forgetting empty session ${sessionId.slice(0, 8)}`, {
      event: "session.forget_empty",
      sessionId,
    });
    this.deps.forgetSession(sessionId);
    this.wsHub.broadcast({
      type: "session_list",
      sessions: this.sessionStore.list(this.deps.ptyAttachedIds()),
    });
  }

  /**
   * Same empty-unused check stop uses (promptCount === 0 and no cache row,
   * including boundConversationId / resumedFromConversationId). Safe after
   * putOnHold: the runner may already have dropped the live session.
   */
  forgetIfEmptyUnused(sessionId: string): void {
    const live = this.ptyManager.getSession(sessionId);
    const stored = this.sessionStore.getManaged(sessionId);
    const session = live ?? stored;
    if (!session) return;
    if (!this.shouldForgetEmptySession(session)) return;
    this.forgetEmptyStoppedSession(sessionId);
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
      const { outcome, session: settled } = await this.deps.waitForStartupOutcome(
        session.id,
        START_READY_TIMEOUT_MS,
      );
      const current = this.sessionStore.get(session.id, this.deps.ptyAttachedIds());

      if (outcome === "ready" && current) {
        json(res, 200, { session: current });
      } else if (outcome === "failed" && current) {
        // The diagnosed reason rides on the settled session, not on the store
        // copy — same as the Codex resume path below. Reading only the store
        // here is what turned "the Claude binary is not accessible" into a
        // bare "exited before becoming ready".
        json(res, 502, {
          id: session.id,
          status: "idle",
          error: settled?.failureReason ?? "Session exited before becoming ready",
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
      const code = (err as Error & { code?: unknown }).code;
      this.log.error(`[start] failed to start session: ${message}`, {
        event: "session.start_failed",
        error: message,
      });
      json(
        res,
        statusCode,
        typeof code === "string" ? { error: message, code } : { error: message },
      );
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
