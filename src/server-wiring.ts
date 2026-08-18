import type { EventEmitter } from "events";
import { statSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import type { WebSocket } from "ws";
import type { AgentClient } from "./agent/agent-client";
import type { AgentConfig } from "./agent/agent-config";
import type { ConversationWriter } from "./agent/conversation-writer";
import type { ConversationHandlers } from "./api/handlers/conversations.handlers";
import type { SessionHandlers } from "./api/handlers/sessions.handlers";
import type { ApiDeps } from "./api/types/api-deps";
import { ConversationCache } from "./conversation-cache";
import type { CacheMetadataRepository } from "./db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "./db/repositories/conversations.repository";
import type { DevicesRepository } from "./db/repositories/devices.repository";
import type { ManagedSessionsRepository } from "./db/repositories/managed-sessions.repository";
import type { ProjectsRepository } from "./db/repositories/projects.repository";
import type { PushRepository } from "./db/repositories/push.repository";
import type { SessionsRepository } from "./db/repositories/sessions.repository";
import type { RuntimeStore } from "./db/runtime-store";
import type { ExternalTailManager } from "./external-tails";
import { handleListProjects } from "./handlers/handleListProjects";
import type { LiveSessionManager } from "./live-session-manager";
import { getLogger, type Logger } from "./logger";
import { REPLAY_MAX_LINES } from "./pty-shared";
import type { ScannerManager } from "./scanner-manager";
import type { CacheIntegrityMonitor } from "./services/cache-integrity/cacheIntegrityMonitor";
import type {
  ConversationWatcher,
  ConversationWatcherEvents,
} from "./services/conversations/conversationWatcher";
import type { HostPressureMonitor } from "./services/host-pressure/hostPressure";
import type { LiveActivityNotifier } from "./services/push/liveActivityNotifier";
import type { WaitingInputNotifier } from "./services/push/waitingInputNotifier";
import { type Capability, hasCapability, type Principal } from "./services/security/capabilities";
import type { ReconcileVerdict } from "./services/sessions/reconcileSessions";
import type { SessionStore } from "./session-store";
import type {
  AskQuestion,
  PermissionOption,
  PTYManagerOptions,
  ServerWarmupState,
  SessionResponse,
} from "./types";
import type { WSHub } from "./ws-hub";

/**
 * Whether a socket's principal may send a given frame.
 *
 * A null principal means authMiddleware never set one, which for `/ws` — a
 * route it classifies as `history:read` — happens only on a bypass path. Today
 * that is `--local-no-auth`, which grants unauthenticated full access to
 * loopback callers by design, so allowing it here keeps the socket telling the
 * same story as the HTTP routes rather than being stricter than them.
 *
 * Deliberately local rather than exported: it is a fail-OPEN helper, correct
 * only where the caller has already established that a null principal means a
 * deliberate bypass.
 */
function wsAllows(principal: Principal | null, required: Capability): boolean {
  return principal === null || hasCapability(principal, required);
}

/** The permission gate currently open for a session (scraped via OSC 777). */
export type PendingPermission = {
  prompt?: string;
  detail?: string;
  options: PermissionOption[];
  cursor?: number;
};

/** The AskUserQuestion card currently broadcast for a session. */
export type PendingQuestion = {
  toolUseId: string;
  questions: AskQuestion[];
  origin: "pty" | "jsonl";
};

/**
 * Everything the ConversationWatcher callbacks read from the server. Thunks
 * rather than values for anything constructed after the watcher itself
 * (`externalTailManager`, and `fileWatcher` — which IS the watcher these
 * callbacks are handed to) or swapped on the instance by tests (`log`,
 * `broadcastConversationLines`); the same reason ScannerManagerDeps passes
 * `cache: () => ConversationCache | null`.
 *
 * The Maps are the server's own, held by reference: they stay StreamerServer
 * state and are read directly elsewhere in server.ts.
 */
export type ConversationWatcherWiringDeps = {
  sessionFileMap: Map<string, string>;
  pendingLineSeqs: Map<string, (number | null)[]>;
  scannerManager: ScannerManager;
  cache: () => ConversationCache | null;
  log: () => Logger;
  fileWatcher: () => ConversationWatcher;
  externalTailManager: () => ExternalTailManager;
  trackCacheWrite: (task: Promise<unknown>) => void;
  processJsonlQuestions: (sessionId: string, lines: string[]) => void;
  broadcastConversationLines: (
    sessionId: string,
    lines: string[],
    seqs?: (number | null)[] | null,
  ) => void;
};

/**
 * The JSONL tail/offset-index/directory callbacks StreamerServer hands to its
 * ConversationWatcher.
 *
 * Extracted from the constructor so watcher work stops editing the server file
 * (see docs/plans/2026-07-12-server-ts-split.md, PR 7). State stays on the
 * server: these callbacks only reach it through `deps`.
 */
export function createConversationWatcherEvents(
  deps: ConversationWatcherWiringDeps,
): ConversationWatcherEvents {
  return {
    onNewLineSpans: (filePath, spans, readFrom, endOffset) => {
      // Offset index: extend the per-message byte-span index with this read's
      // lines. Fires alongside onNewLines (which writes the tail); both
      // consume the same read. Best-effort — a failure here must never break
      // the tail write or WS broadcast.
      const cache = deps.cache();
      if (!cache) return;
      // No stale seqs from a prior read may leak into this one's WS stamping.
      deps.pendingLineSeqs.delete(filePath);
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
          deps.trackCacheWrite(
            cache.backfillIndex(filePath).catch((err) => {
              deps.log().warn("offset-index.backfill_failed", {
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
        deps.pendingLineSeqs.set(filePath, seqs);
      } catch (err) {
        deps.log().warn("offset-index.extend_failed", {
          event: "offset_index.extend_failed",
          filePath,
          err,
        });
      }
    },
    onNewLines: (filePath, lines) => {
      // One transactional cache write for the whole batch instead of per line.
      deps.cache()?.updateFromLines(filePath, lines);
      let managed = false;
      for (const [sessionId, watchedPath] of deps.sessionFileMap) {
        if (watchedPath === filePath) {
          managed = true;
          deps.processJsonlQuestions(sessionId, lines);
          // Additive batched event (one socket write) for newer clients. When
          // the offset index assigned seqs for this read, carry them parallel
          // to lines so a client can map each event to its message_index.
          // Codex rollout lines are normalized to Claude shape here — mobile
          // parseLineToMessage only understands type:user|assistant.
          const seqs = deps.pendingLineSeqs.get(filePath);
          deps.broadcastConversationLines(sessionId, lines, seqs);
          break;
        }
      }
      // No PTY owns this file: it's an external tail (or nothing at all, in
      // which case the call is a no-op). Transcript push only — never the
      // managed-session events, and never a question card.
      if (!managed) {
        deps
          .externalTailManager()
          .broadcastExternalTailLines(filePath, lines, deps.pendingLineSeqs.get(filePath));
      }
      // Seqs are consumed for this read; drop them so a later read for a file
      // with no watched session can't reuse a stale mapping.
      deps.pendingLineSeqs.delete(filePath);
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
        deps.externalTailManager().handleJsonlDeleted(filePath);
        return;
      }
      // A new JSONL appeared (or changed) in a watched project directory.
      // If we hold a per-file tail for it, re-drive the tail read from here
      // too: per-file fs.watch handles can die silently (2026-07-01 incident
      // — tails went permanently quiet while directory events kept flowing),
      // and the directory watcher is the survivor that can heal them.
      const tailed = deps.fileWatcher().poke(filePath);
      // Nobody is tailing it yet — if an external agent is actively writing
      // it, attach a tail so its transcript is pushed instead of silently
      // waiting for the client to poll.
      if (!tailed) deps.externalTailManager().maybeAttachExternalTail(filePath);
      deps.externalTailManager().sweepIdleExternalTails();
      // Upsert-or-leave: a change event NEVER deletes the cache row (skipIfTailed).
      // This same append also drives the live-tail watcher's updateFromLines
      // upsert; the two fire with no ordering guarantee, so deleting here would
      // wipe a row the live tail just wrote (CRITICAL #2) — and a refresh-created
      // untailed row would vanish on its next append. The debounced rescan below
      // re-derives metadata, so leaving the row loses nothing.
      deps.cache()?.invalidateByFilePath(filePath, { skipIfTailed: true });
      // Debounce the scanner-staleness flip so a burst of directory events
      // during active sessions collapses into one reconcile trigger after a
      // quiet period. The debounced callback still checks scannerReady at
      // fire time, preserving the anti-infinite-loop rule (never null
      // scannerReady mid-scan). Record the path before debouncing so the
      // reconcile can refresh exactly this file instead of the whole tree.
      deps.scannerManager.staleFiles.add(filePath);
      deps.scannerManager.markStaleDebounced();
      deps.log().debug?.(`Scanner invalidated by directory event: ${filePath}`, {
        filePath,
        event: "cache.directory_change",
      });
    },
    onTruncated: (filePath) => {
      // The file shrank below our offset — it is a different generation of
      // content now, so every byte span we recorded for it is meaningless.
      // Drop the index (and its parse state); the next read rebuilds from 0.
      deps.cache()?.deleteFileIndex(filePath, ConversationCache.conversationIdForFile(filePath));
      deps.cache()?.clearIndexParseState(filePath);
      deps.log().warn(`JSONL truncated/replaced; offset index dropped: ${filePath}`, {
        filePath,
        event: "tail.truncated",
      });
    },
    onFileDeleted: (filePath) => deps.externalTailManager().handleJsonlDeleted(filePath),
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
      deps
        .log()
        .error(
          enospc
            ? `Watcher hit the OS watch-handle limit on ${filePath} — raise fs.inotify.max_user_watches (Linux) or the process fd limit; conversation discovery and live tails are degraded until then`
            : `Watcher error on ${filePath}: ${err.message}`,
          { filePath, err, event: enospc ? "watcher.limit_exhausted" : "watcher.error" },
        );
    },
  };
}

/**
 * Everything the LiveSessionManager callbacks read from the server. Same thunk
 * discipline: `sessionHandlers` is constructed after the runner, the repos and
 * notifiers are bound during listen(), and `log` is swapped by tests.
 */
export type LiveSessionWiringDeps = {
  sessionStore: SessionStore;
  wsHub: WSHub;
  fileWatcher: ConversationWatcher;
  scannerManager: ScannerManager;
  sessionStatusBus: EventEmitter;
  sessionFileMap: Map<string, string>;
  sessionSubscribers: Map<string, Set<WebSocket>>;
  lastAgentChunkAt: Map<string, number>;
  terminalSeq: Map<string, number>;
  pendingQuestions: Map<string, PendingQuestion>;
  pendingQuestionKey: Map<string, string>;
  pendingPermission: Map<string, PendingPermission>;
  pendingPermissionKey: Map<string, string>;
  contendedSessions: Set<string>;
  log: () => Logger;
  sessionHandlers: () => SessionHandlers;
  managedSessionsRepo: () => ManagedSessionsRepository | null;
  liveActivityNotifier: () => LiveActivityNotifier | null;
  waitingInputNotifier: () => WaitingInputNotifier | null;
  ptyAttachedIds: () => Set<string>;
  cancelPendingQuestion: (sessionId: string) => void;
  rememberSelfPtyEnded: (conversationId: string) => void;
  maybeFireHoldWhenIdle: (session: { id: string; status: string }) => void;
};

/**
 * The options StreamerServer hands to its LiveSessionManager: terminal/user
 * output fan-out, gate and question plumbing, and the status funnel that
 * mirrors every transition into SessionStore, the durable registry, the
 * scanner index and the push notifiers.
 *
 * Extracted from the constructor for the same reason as the watcher events
 * above; the server keeps every Map and Set these callbacks mutate.
 */
export function createLiveSessionOptions(deps: LiveSessionWiringDeps): PTYManagerOptions {
  return {
    logger: getLogger("pty"),
    onOutput: (sessionId, data) => {
      // Agent-activity stamp for the idle reaper. Fires for every provider
      // (both runners call onOutput), so the reaper needs no per-runner
      // bookkeeping. Distinct from ManagedSession.lastActivityAt, which only
      // moves on *user* input — an agent grinding through a long task is
      // active even when nobody has touched it.
      deps.lastAgentChunkAt.set(sessionId, Date.now());
      const seq = (deps.terminalSeq.get(sessionId) ?? 0) + 1;
      deps.terminalSeq.set(sessionId, seq);
      deps.wsHub.broadcastToClients(deps.sessionSubscribers.get(sessionId) ?? [], {
        type: "terminal_output",
        sessionId,
        data,
        seq,
      });
    },
    onPhaseChange: (sessionId, phase) => {
      // Mirror into SessionStore so the REST field carries it too. The runner
      // mutates its own InternalSession and toPublicSession does not forward
      // subStatus, so without this `GET /api/sessions/:id` reports null for the
      // whole turn and only a subscribed socket ever sees a phase.
      deps.sessionStore.updateManaged(sessionId, { subStatus: phase });
      // Scoped to this session's subscribers and sent as a minimal frame —
      // NOT routed through onStatusChange's handler, which writes a DB row,
      // refreshes the scanner index, broadcasts globally and pokes the APNs
      // and push notifiers on every call. This can fire every scrape tick.
      deps.wsHub.broadcastToClients(deps.sessionSubscribers.get(sessionId) ?? [], {
        type: "session_phase",
        sessionId,
        phase,
        updatedAt: new Date().toISOString(),
      });
    },
    onUserMessage: (sessionId, text, ts) => {
      deps.wsHub.broadcastToClients(deps.sessionSubscribers.get(sessionId) ?? [], {
        type: "user_message",
        sessionId,
        text,
        ts,
      });
    },
    onPermissionChange: (sessionId, gate) => {
      deps.sessionHandlers().handlePermissionChange(sessionId, gate);
    },
    onLiveQuestion: (sessionId, questions) => {
      deps.sessionHandlers().handleLiveQuestion(sessionId, questions);
    },
    onLiveQuestionGone: (sessionId) => {
      // The rendered AskUserQuestion menu closed on this streamer's own live
      // PTY — authoritative regardless of whether pendingQuestions still holds
      // the screen-synthesized id or the real toolUseId a JSONL flush swapped
      // in later. Gating on the "screen:" prefix (as this used to) assumed the
      // JSONL id meant handleSendAnswer had already cleared it, which only
      // holds when the menu closed BECAUSE we answered it — not when it closed
      // via Esc, an answer typed at the host keyboard, /clear, or the model
      // giving up, all of which leave pendingQuestions holding the real id.
      deps.pendingQuestionKey.delete(sessionId);
      deps.cancelPendingQuestion(sessionId);
    },
    onReady: (session) => {
      const resp = deps.sessionStore.get(session.id, deps.ptyAttachedIds());
      if (resp) deps.wsHub.broadcast({ type: "session_ready", session: resp });
    },
    onStatusChange: (session) => {
      // Captured before the update below overwrites it — the Live Activity
      // notifier needs the pre-transition status to tell a genuine
      // waiting_input↔running edge apart from a same-status re-emit.
      const previousStatus = deps.sessionStore.getManaged(session.id)?.status;
      deps.sessionStore.updateManaged(session.id, {
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
        // Why a session died, not just that it did. Without this the store's
        // copy has no failureReason, so managedToResponse falls through to
        // `lifecycle: "completed"` (see session-store.ts) and a session that
        // never started — missing CLI, missing project dir — is reported to
        // every client as one that finished normally. Guarded like its
        // neighbours: a later transition must not blank a recorded failure.
        ...(session.failureReason != null && { failureReason: session.failureReason }),
        ...(session.failureCode != null && { failureCode: session.failureCode }),
      });
      // Mirror the transition into the durable registry. Both runners funnel
      // every status change through this callback, so this is the one place
      // that needs to know. `exit` vs `transition` is the distinction the
      // reconciler cares about: a row with a recorded exit needs no probe.
      deps
        .managedSessionsRepo()
        ?.recordStatus(
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
        const filePath = deps.sessionFileMap.get(session.id);
        if (filePath) {
          deps.scannerManager
            .get()
            .then((scanner) => deps.scannerManager.refreshFileGuarded(scanner, filePath))
            .then((meta) => {
              // meta === null means the guard coalesced/skipped this refresh
              // (already in flight or within the TTL) — not a real result.
              deps.log().info("scanner.refreshFile: ok", {
                event: "scanner.refresh",
                sessionId: session.id,
                filePath,
                trigger: session.status,
                messageCount: meta?.messageCount,
              });
            })
            .catch((err) => {
              deps.log().warn("scanner.refreshFile: failed", {
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
        const filePath = deps.sessionFileMap.get(session.id);
        if (filePath) {
          deps.fileWatcher.unwatch(filePath);
          deps.sessionFileMap.delete(session.id);
          deps.cancelPendingQuestion(session.id);
        }
        // A gone PTY can never have an open gate; clear silently.
        deps.pendingPermission.delete(session.id);
        deps.pendingPermissionKey.delete(session.id);
        deps.contendedSessions.delete(session.id);
        // Remember that WE owned this conversation up to now, so a resume that
        // follows a hold isn't mistaken for a collision with someone else
        // (see conversationBusy's selfPtyEndedAt).
        deps.rememberSelfPtyEnded(session.id);
      }
      const resp = deps.sessionStore.get(session.id, deps.ptyAttachedIds());
      if (resp) {
        deps.wsHub.broadcast({ type: "session_update", session: resp });
      }
      // Push the transition to any iOS Live Activity watching this session.
      // Fire-and-forget: the notifier logs its own failures, and a push must
      // never delay or fail a session transition. No-op when APNs is off.
      void deps.liveActivityNotifier()?.onStatusChange(session, previousStatus);
      // And tell the phone its turn is up, if nobody is watching this session
      // already. Same funnel, same fire-and-forget contract as above.
      void deps.waitingInputNotifier()?.onStatusChange(session, previousStatus);
      // The session object rides along: SessionStore's copy is a partial
      // merge that does not carry failureReason/failureCode, so a startup
      // handshake reading the store could not tell WHY a session went idle.
      deps.sessionStatusBus.emit(`status:${session.id}`, session.status, session);
      // Kill-on-idle latch: hold at the next waiting_input/idle if a client
      // armed `hold_session` with when:"waiting_input". Both runners (and the
      // pty-host remote runner) funnel status here, so this is the one fire
      // site. Optional so unit tests that stub LiveSessionWiringDeps stay valid.
      deps.maybeFireHoldWhenIdle?.(session);
    },
  };
}

/**
 * Everything the ApiDeps assembly reads from the server.
 *
 * Values where the original literal captured a value (`publicUrl`,
 * `browseRoot`, and the collaborators built earlier in the constructor);
 * thunks and arrows everywhere the original used them, which is load-bearing:
 * the stores open during listen(), `apiKey` changes under rotateApiKey(), and
 * tests swap `log`/`startGraceTimer`/`broadcastConversationLines` on the
 * server instance after construction.
 */
export type ApiDepsWiring = {
  apiKey: () => string;
  localNoAuth: boolean;
  logMenubarRequests: boolean;
  publicUrl: string | null;
  browseRoot: string | null;
  browserCors: string | undefined;
  ptyGracePeriodMs: number;
  rotateApiKey: ApiDeps["rotateApiKey"];
  claudeFlagsConfig: ApiDeps["claudeFlagsConfig"];
  featureFlagsConfig: ApiDeps["featureFlagsConfig"];
  setClaudeFlagsConfig: ApiDeps["setClaudeFlagsConfig"];
  ptyManager: LiveSessionManager;
  sessionStore: SessionStore;
  wsHub: WSHub;
  sessionHandlers: SessionHandlers;
  conversationHandlers: ConversationHandlers;
  cache: () => ConversationCache | null;
  cacheMonitor: () => CacheIntegrityMonitor | null;
  hostPressureMonitor: () => HostPressureMonitor | null;
  pushRepo: () => PushRepository | null;
  liveActivityPushEnabled: () => boolean;
  devicesRepo: () => DevicesRepository | null;
  projectsRepo: () => ProjectsRepository | null;
  conversationsRepo: () => ConversationsRepository | null;
  sessionsRepo: () => SessionsRepository | null;
  cacheMetadataRepo: () => CacheMetadataRepository | null;
  runtimeStore: () => RuntimeStore | null;
  managedSessionsRepo: () => ManagedSessionsRepository | null;
  sessionVerdicts: () => Map<string, ReconcileVerdict>;
  log: () => Logger;
  ptyAttachedIds: () => Set<string>;
  withReconciledLifecycle: (sessions: readonly SessionResponse[]) => readonly SessionResponse[];
  currentWarmupState: () => ServerWarmupState | null;
  addSessionSubscriber: (sessionId: string, ws: WebSocket) => void;
  startGraceTimer: (sessionId: string, delayMs: number) => void;
  armHoldWhenIdle: (sessionId: string) => void;
  handleSessionsCount: (res: ServerResponse) => void;
  applyLiveSessionSetting: (
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
    setting: "model" | "effort",
  ) => Promise<void>;
  handlePairStart: (res: ServerResponse) => void;
  handlePairExchange: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleBrowse: (url: URL, res: ServerResponse) => Promise<void>;
  handleMkdir: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  clientIdToWs: Map<string, WebSocket>;
  wsToClientId: Map<WebSocket, string>;
  sessionSubscribers: Map<string, Set<WebSocket>>;
  terminalSeq: Map<string, number>;
  pendingPermission: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  agentClient: AgentClient | null;
  conversationWriter: ConversationWriter | null;
  agentConfig: AgentConfig;
};

/**
 * Assemble the dependency bag the Hono app and the WS routes are built from,
 * including the three WebSocket lifecycle handlers.
 *
 * Extracted from the constructor for the same reason as the two factories
 * above; every key, its order and its target are unchanged.
 */
export function createApiDeps(deps: ApiDepsWiring): ApiDeps {
  return {
    // ponytail: getter so rotateApiKey() takes effect without restarting the server
    get apiKey() {
      return deps.apiKey();
    },
    localNoAuth: deps.localNoAuth,
    logMenubarRequests: deps.logMenubarRequests,
    rotateApiKey: () => deps.rotateApiKey(),
    claudeFlagsConfig: () => deps.claudeFlagsConfig(),
    featureFlagsConfig: () => deps.featureFlagsConfig(),
    setClaudeFlagsConfig: (values, extraArgs) => deps.setClaudeFlagsConfig(values, extraArgs),
    publicUrl: deps.publicUrl,
    browseRoot: deps.browseRoot,
    browserCors: deps.browserCors,
    ptyManager: deps.ptyManager,
    sessionStore: deps.sessionStore,
    wsHub: deps.wsHub,
    cache: () => deps.cache(),
    cacheMonitor: () => deps.cacheMonitor(),
    hostPressureMonitor: () => deps.hostPressureMonitor(),
    pushRepo: () => deps.pushRepo(),
    liveActivityPushEnabled: () => deps.liveActivityPushEnabled(),

    devicesRepo: () => deps.devicesRepo(),
    projectsRepo: () => deps.projectsRepo(),
    conversationsRepo: () => deps.conversationsRepo(),
    sessionsRepo: () => deps.sessionsRepo(),
    cacheMetadataRepo: () => deps.cacheMetadataRepo(),
    runtimeStore: () => deps.runtimeStore(),
    managedSessionsRepo: () => deps.managedSessionsRepo(),
    sessionVerdicts: () => deps.sessionVerdicts(),
    ptyAttachedIds: () => deps.ptyAttachedIds(),
    handleListSessions: (url, res) => deps.sessionHandlers.handleListSessions(url, res),
    handleSessionsCount: (res) => deps.handleSessionsCount(res),
    handleGetRecentSessions: (url, res) =>
      deps.conversationHandlers.handleGetRecentSessions(url, res),
    handleGetSessionNames: (res) => deps.sessionHandlers.handleGetSessionNames(res),
    handleGetSession: (id, res) => deps.sessionHandlers.handleGetSession(id, res),
    handleGetOutput: (id, res) => deps.sessionHandlers.handleGetOutput(id, res),
    handleSendInput: (id, req, res) => deps.sessionHandlers.handleSendInput(id, req, res),
    handleSendAnswer: (id, req, res) => deps.sessionHandlers.handleSendAnswer(id, req, res),
    handleCancel: (id, res) => deps.sessionHandlers.handleCancel(id, res),
    handleStopSession: (id, res) => deps.sessionHandlers.handleStopSession(id, res),
    handleSetSessionName: (id, req, res) => deps.sessionHandlers.handleSetSessionName(id, req, res),
    handleSetSessionModel: (id, req, res) => deps.applyLiveSessionSetting(id, req, res, "model"),
    handleSetSessionEffort: (id, req, res) => deps.applyLiveSessionSetting(id, req, res, "effort"),
    handleUploadFile: (id, req, res) => deps.sessionHandlers.handleUploadFile(id, req, res),
    handleAdopt: (id, res) => deps.sessionHandlers.handleAdopt(id, res),
    handleFork: (id, req, res) => deps.sessionHandlers.handleFork(id, req, res),
    handleResume: (req, res) => deps.sessionHandlers.handleResume(req, res),
    handleStartSession: (req, res) => deps.sessionHandlers.handleStartSession(req, res),
    handleListConversations: (url, res) =>
      deps.conversationHandlers.handleListConversations(url, res),
    handleConversationsCount: (url, res) =>
      deps.conversationHandlers.handleConversationsCount(url, res),
    handleGetConversation: (id, url, res, ifNoneMatch) =>
      deps.conversationHandlers.handleGetConversation(id, url, res, ifNoneMatch),
    handleSearch: (url, res) => deps.conversationHandlers.handleSearch(url, res),
    handleSearchTarget: (id, req, res) =>
      deps.conversationHandlers.handleSearchTarget(id, req, res),
    handleListProjects: (url, res) => handleListProjects(url, res),
    handleGetPopularProjects: (url, res) =>
      deps.conversationHandlers.handleGetPopularProjects(url, res),
    handleGetProjectSummaries: (url, res) =>
      deps.conversationHandlers.handleGetProjectSummaries(url, res),
    handlePairStart: (res) => deps.handlePairStart(res),
    handlePairExchange: (req, res) => deps.handlePairExchange(req, res),
    handleBrowse: (url, res) => deps.handleBrowse(url, res),
    handleMkdir: (req, res) => deps.handleMkdir(req, res),
    handleWsOpen: (ws) => {
      deps.wsHub.addClient(ws);
      const sessions = deps.withReconciledLifecycle(deps.sessionStore.list(deps.ptyAttachedIds()));
      ws.send(JSON.stringify({ type: "session_list", sessions }));
      if (!deps.currentWarmupState()) {
        ws.send(JSON.stringify({ type: "cache_ready" }));
      }
      // Re-surface a pending cache-integrity alert to every connecting client
      // (covers the startup warm-up window and every reconnect).
      const alertMsg = deps.cacheMonitor()?.wsMessage();
      if (alertMsg) deps.wsHub.unicast(ws, alertMsg);
      const pressureMsg = deps.hostPressureMonitor()?.wsMessage();
      if (pressureMsg) deps.wsHub.unicast(ws, pressureMsg);
    },
    handleWsMessage: async (ws, raw, principal) => {
      // A refused frame is dropped and logged rather than answered: the
      // server→client union has no error type (types.ts), and adding one is a
      // contract change older clients would ignore anyway. Dropping matches how
      // this handler already treats malformed JSON; the log is what makes the
      // refusal diagnosable.
      const deny = (type: string, required: Capability): void => {
        deps.log().warn(`[ws.capability_denied] ${type} requires ${required}`, {
          event: "ws.capability_denied",
          type,
          required,
          ...(principal?.deviceId ? { deviceId: principal.deviceId } : {}),
        });
      };
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "register" && typeof msg.clientId === "string") {
          const oldClientId = deps.wsToClientId.get(ws);
          if (oldClientId) deps.clientIdToWs.delete(oldClientId);
          deps.clientIdToWs.set(msg.clientId, ws);
          deps.wsToClientId.set(ws, msg.clientId);
        }
        if (msg.type === "subscribe_session" && typeof msg.sessionId === "string") {
          // Reading a session's stream is the same authority as reading its
          // history over HTTP. Checked per frame rather than inherited from the
          // upgrade, so this is the seam any future per-project scoping hangs
          // off — it does not add scoping today, and every preset holds
          // history:read, so no client's behaviour changes.
          if (!wsAllows(principal, "history:read")) {
            deny(msg.type, "history:read");
            return;
          }
          deps.addSessionSubscriber(msg.sessionId, ws);
          if (deps.ptyManager.hasSession(msg.sessionId)) {
            // Replay everything the session's render terminal still holds; it
            // caps itself (REPLAY_MAX_LINES) and the client keeps its own,
            // larger, retention cap. The old fixed 200 was under a fifth of
            // that, so most of a live session's scrollback was unreachable on
            // the client however far back it could scroll.
            const lines = await deps.ptyManager.getOutputLines(msg.sessionId, REPLAY_MAX_LINES);
            const userMessages = deps.ptyManager.getInputHistory(msg.sessionId);
            ws.send(
              JSON.stringify({
                type: "terminal_replay",
                sessionId: msg.sessionId,
                lines,
                userMessages,
                seq: deps.terminalSeq.get(msg.sessionId),
              }),
            );
          }
          // A gate/question can open before the client finishes subscribing
          // (Codex's startup gates fire within ~500ms of spawn) — broadcast()
          // only reaches already-subscribed sockets, so a card that opened in
          // that window is otherwise lost forever. Replay pending state the
          // same way terminal_replay does above.
          const pendingGate = deps.pendingPermission.get(msg.sessionId);
          if (pendingGate) {
            deps.log().info(`[ws.replay_permission] ${msg.sessionId.slice(0, 8)}`, {
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
          const pendingQuestion = deps.pendingQuestions.get(msg.sessionId);
          if (pendingQuestion) {
            deps.log().info(`[ws.replay_question] ${msg.sessionId.slice(0, 8)}`, {
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
          // Holding a session SIGINTs the agent and disposes its screen, which
          // is control, not reading — a read-only device could previously stop
          // any session by id with a single frame, because the only check this
          // path ever had was the upgrade's `history:read`.
          if (!wsAllows(principal, "session:control")) {
            deny(msg.type, "session:control");
            return;
          }
          // Additive `when` on the existing frame. Omitted / "grace" is today's
          // backgrounding path (ptyGracePeriodMs). "waiting_input" latches a
          // hold at the end of the current turn. Anything else is ignored —
          // do not fall through to grace, including for read-only (already
          // returned above).
          const when = msg.when;
          if (when === undefined || when === "grace") {
            deps.startGraceTimer(msg.sessionId, deps.ptyGracePeriodMs);
            return;
          }
          if (when === "waiting_input") {
            deps.armHoldWhenIdle(msg.sessionId);
            return;
          }
          deps.log().warn(`[pty.hold_when_unknown] hold_session when=${String(when)}`, {
            event: "pty.hold_when_unknown",
            sessionId: msg.sessionId,
            when,
          });
        }
      } catch {
        // malformed JSON, ignore
      }
    },
    handleWsClose: (ws) => {
      const clientId = deps.wsToClientId.get(ws);
      if (clientId) {
        deps.clientIdToWs.delete(clientId);
        deps.wsToClientId.delete(ws);
      }
      for (const subscribers of deps.sessionSubscribers.values()) {
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
    agentClient: deps.agentClient,
    conversationWriter: deps.conversationWriter,
    agentConfig: deps.agentConfig,
  };
}
