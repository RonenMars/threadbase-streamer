import { createProgressDedupeLRU } from "./agent/dedupe";
import { CLAUDE_CODE_PROVIDER } from "./providers";
import type {
  DiscoveredProcess,
  ManagedSession,
  SessionCursor,
  SessionListPage,
  SessionListQuery,
  SessionResponse,
  SessionSortKey,
  SortOrder,
} from "./types";
import { confidenceForSource } from "./types";

export class SessionStore {
  private managed = new Map<string, ManagedSession>();
  private discovered = new Map<number, DiscoveredProcess>();

  addManaged(session: ManagedSession): void {
    this.managed.set(session.id, session);
  }

  /**
   * Multi-agent mode only. Attach a dedupe LRU to a session record. Idempotent —
   * calling twice keeps the existing LRU (and its contents).
   */
  initAgentSession(sessionId: string, dedupeCapacity: number): void {
    const session = this.managed.get(sessionId);
    if (!session) return;
    if (session.progressDedupeIds) return;
    session.progressDedupeIds = createProgressDedupeLRU(dedupeCapacity);
  }

  updateManaged(sessionId: string, updates: Partial<ManagedSession>): ManagedSession | null {
    const session = this.managed.get(sessionId);
    if (!session) return null;
    Object.assign(session, updates);
    return session;
  }

  removeManaged(sessionId: string): boolean {
    return this.managed.delete(sessionId);
  }

  /**
   * The **live** stored record — mutating it mutates the store. Paired with
   * `get()`, which hands back a throwaway response copy. Prefer
   * `updateManaged()` for writes; this is for readers that need the internal
   * shape (Date fields, `rehydrated`, …) rather than the wire shape.
   */
  getManaged(sessionId: string): ManagedSession | null {
    return this.managed.get(sessionId) ?? null;
  }

  setDiscovered(processes: DiscoveredProcess[]): void {
    this.discovered.clear();
    for (const proc of processes) {
      this.discovered.set(proc.pid, proc);
    }
  }

  /**
   * The **live** stored records — mutating an element mutates the store. Paired
   * with `list()`, which hands back throwaway response copies.
   */
  listManaged(): ManagedSession[] {
    return Array.from(this.managed.values());
  }

  // Build the session list: live PTY sessions (managed) merged with externally
  // discovered Claude processes. Managed sessions keyed by JSONL UUID take
  // priority — discovered processes with the same UUID are skipped.
  //
  // Returns freshly constructed response objects, NOT references into the
  // store — hence `Readonly`: writing to one changes nothing, so the compiler
  // refuses it. Persist state with `updateManaged()`; to decorate a response,
  // build a new object (`{ ...s, … }`) as `withReconciledLifecycle` does.
  list(ptyAttachedIds: Set<string>): readonly Readonly<SessionResponse>[] {
    const results: SessionResponse[] = [];
    const seenIds = new Set<string>();

    for (const s of this.managed.values()) {
      results.push(managedToResponse(s, ptyAttachedIds.has(s.id)));
      seenIds.add(s.id);
    }

    for (const d of this.discovered.values()) {
      if (!d.conversationId) continue;
      if (seenIds.has(d.conversationId)) continue;
      results.push(discoveredToResponse(d, d.conversationId));
      seenIds.add(d.conversationId);
    }

    return results;
  }

  // A freshly constructed response object, NOT a reference into the store —
  // hence `Readonly`, for the same reason as `list()` above. Use `getManaged()`
  // when you want the live record.
  get(sessionId: string, ptyAttachedIds: Set<string>): Readonly<SessionResponse> | null {
    const managed = this.managed.get(sessionId);
    if (managed) return managedToResponse(managed, ptyAttachedIds.has(sessionId));

    for (const d of this.discovered.values()) {
      if (d.conversationId === sessionId) return discoveredToResponse(d, sessionId);
    }

    return null;
  }

  // Paginated, sorted, filtered view over the same merged data list() exposes.
  // The discovery cache can mutate the underlying set between requests, so the
  // cursor encodes both the chosen sort key value and the session id as a
  // tiebreaker. New sessions appearing mid-scan are picked up on the next
  // refetch — see plan for caveats.
  paginate(ptyAttachedIds: Set<string>, query: SessionListQuery): SessionListPage {
    const all = this.list(ptyAttachedIds);

    const filtered = query.status?.length
      ? all.filter((s) => query.status?.includes(s.status))
      : all;

    const sorted = [...filtered].sort(makeComparator(query.sortBy, query.order));

    const total = sorted.length;

    const startIdx = query.cursor
      ? findCursorBoundary(sorted, decodeCursor(query.cursor), query.sortBy, query.order)
      : 0;
    const page = sorted.slice(startIdx, startIdx + query.limit);
    const last = page[page.length - 1];
    const nextCursor =
      last && startIdx + page.length < sorted.length
        ? encodeCursor({ k: getSortValue(last, query.sortBy) ?? "", id: last.id })
        : null;

    return { sessions: page, nextCursor, total };
  }
}

// Cursor encoding is opaque to clients: base64url(JSON({ k, id })).
export function encodeCursor(c: SessionCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s: string): SessionCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as SessionCursor).id !== "string" ||
    !["string", "number"].includes(typeof (parsed as SessionCursor).k)
  ) {
    throw new Error("INVALID_CURSOR");
  }
  return parsed as SessionCursor;
}

function getSortValue(s: SessionResponse, key: SessionSortKey): string | number | undefined {
  switch (key) {
    case "startedAt":
      return s.startedAt;
    case "lastActivityAt":
      return s.lastActivityAt ?? s.startedAt;
    case "projectName":
      return s.projectName;
    case "status":
      return s.status;
  }
}

function compareValues(a: string | number | undefined, b: string | number | undefined): number {
  // Undefined sorts last regardless of order; callers normalise via getSortValue
  // so this branch only fires for genuinely missing values.
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function makeComparator(key: SessionSortKey, order: SortOrder) {
  const dir = order === "asc" ? 1 : -1;
  return (a: SessionResponse, b: SessionResponse): number => {
    const cmp = compareValues(getSortValue(a, key), getSortValue(b, key)) * dir;
    if (cmp !== 0) return cmp;
    // Tiebreaker on id is always ascending so the total order is stable
    // regardless of `order`.
    return a.id.localeCompare(b.id);
  };
}

// Returns the index of the first element strictly *after* the cursor under the
// chosen ordering. Linear scan is fine: total session counts are in the
// hundreds, not millions.
function findCursorBoundary(
  sorted: SessionResponse[],
  cursor: SessionCursor,
  key: SessionSortKey,
  order: SortOrder,
): number {
  const dir = order === "asc" ? 1 : -1;
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    const cmp = compareValues(getSortValue(item, key), cursor.k) * dir;
    if (cmp > 0) return i;
    if (cmp === 0 && item.id.localeCompare(cursor.id) > 0) return i;
  }
  return sorted.length;
}

/** Multi-agent sessions set `currentTurnId` (possibly null); PTY sessions leave it undefined. */
function isLiveMultiAgent(s: ManagedSession): boolean {
  return s.currentTurnId !== undefined && (s.status === "running" || s.status === "waiting_input");
}

function managedToResponse(s: ManagedSession, ptyAttached: boolean): SessionResponse {
  return {
    id: s.id,
    conversationId: s.id,
    provider: s.provider ?? CLAUDE_CODE_PROVIDER,
    status: s.status,
    // Lifecycle for a session this run knows about. `attached` while we hold
    // its PTY; once the PTY is gone the session is terminal from this run's
    // perspective — `failed` when it recorded a reason, else `completed`.
    // A `rehydrated` stub is the exception: the boot rehydrator seeded it from
    // the durable registry, so it is a previous run's session with no process
    // behind it — `resumable`, and `historical` rather than `managed`
    // (docs/plans/live-sessions-persistence-plan.md §4, Phase 1).
    // A session this run itself put on hold (grace timer, explicit hold_session,
    // idle reaper) is the other exception: the PTY is gone the same way an exit
    // leaves it gone, but the conversation is still resumable, not terminal —
    // `putOnHold` records that by leaving `statusSource: "shutdown"` (the only
    // place either runner sets it), so it is checked here alongside `rehydrated`.
    // Multi-agent sessions never have a PTY (`currentTurnId` is defined — null
    // while idle between turns — only on that path). While their status is
    // still live they are `attached`, not terminal (#438).
    // Otherwise, terminal requires evidence of termination — a recorded
    // `failureReason`, or the `completedAt` every exit path stamps. Without
    // either, no PTY here means the spawn has not landed, which is `starting`,
    // not `completed` (tb-mobile #508). Scoped to the PTY path only
    // (`currentTurnId === undefined`) — multi-agent never stamps `completedAt`
    // at all, so an idle multi-agent session (no pre-attach race to
    // disambiguate) stays `completed` regardless.
    lifecycle:
      ptyAttached || isLiveMultiAgent(s)
        ? "attached"
        : s.rehydrated || s.statusSource === "shutdown"
          ? "resumable"
          : s.failureReason != null
            ? "failed"
            : s.currentTurnId === undefined && s.completedAt == null
              ? "starting"
              : "completed",
    lifecycleSource:
      ptyAttached || isLiveMultiAgent(s)
        ? s.reconciled
          ? "reconcile"
          : "spawn"
        : s.rehydrated
          ? "reconcile"
          : s.currentTurnId === undefined && s.completedAt == null
            ? "spawn"
            : "exit",
    // We own its PTY, so `status` is the authoritative signal — no inferred
    // `activity` is attached for managed sessions.
    ownership: s.rehydrated ? "historical" : "managed",
    projectPath: s.projectPath,
    projectName: s.projectName,
    branch: s.branch,
    lastOutput: s.lastOutput,
    elapsedMs: (s.completedAt ?? new Date()).getTime() - s.startedAt.getTime(),
    promptCount: s.promptCount,
    startedAt: s.startedAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    ptyAttached,
    ...(s.projectId != null && { projectId: s.projectId }),
    ...(s.sessionName != null && { sessionName: s.sessionName }),
    ...(s.model != null && { model: s.model }),
    ...(s.account != null && { account: s.account }),
    ...(s.messageCount != null && { messageCount: s.messageCount }),
    ...(s.preview != null && { preview: s.preview }),
    ...(s.firstMessageText != null && { firstMessageText: s.firstMessageText }),
    ...(s.firstMessageAt != null && { firstMessageAt: s.firstMessageAt.toISOString() }),
    ...(s.lastMessageText != null && { lastMessageText: s.lastMessageText }),
    ...(s.lastMessageAt != null && { lastMessageAt: s.lastMessageAt.toISOString() }),
    ...(s.lastActivityAt != null && { lastActivityAt: s.lastActivityAt.toISOString() }),
    // C3: how the status was derived, and how far to trust it. Confidence is
    // derived from the source rather than stored, so the two cannot disagree.
    ...(s.statusSource != null && {
      statusSource: s.statusSource,
      statusConfidence: confidenceForSource(s.statusSource),
    }),
    ...(s.statusUpdatedAt != null && { statusUpdatedAt: s.statusUpdatedAt.toISOString() }),
    ...(s.filePath != null && { filePath: s.filePath }),
    ...(s.failureReason != null && { failureReason: s.failureReason }),
    ...(s.resumedFromConversationId != null && {
      resumedFromConversationId: s.resumedFromConversationId,
    }),
    ...(s.forkedFromConversationId != null && {
      forkedFromConversationId: s.forkedFromConversationId,
    }),
    ...(s.boundConversationId != null && { boundConversationId: s.boundConversationId }),
    ...(s.interruptedStatus != null && { interruptedStatus: s.interruptedStatus }),
  };
}

function discoveredToResponse(d: DiscoveredProcess, conversationId: string): SessionResponse {
  return {
    id: conversationId,
    conversationId,
    provider: CLAUDE_CODE_PROVIDER,
    // Stays "idle" deliberately: we cannot see this process's prompt state, and
    // reporting `running` would route mobile to the destructive Overtake screen.
    // Liveness travels in the additive fields below instead.
    status: "idle",
    ownership: "external",
    // Discovery just enumerated this PID, so it was alive moments ago. We never
    // report "gone" here — a vanished process simply stops being listed.
    processLiveness: "alive",
    // Alive, but spawned outside this streamer, so we hold no PTY for it. That
    // is precisely `detached` — and it is strictly more informative than the
    // `status: "idle"` above, which discovery is forced to report because it
    // cannot see the process's prompt state.
    lifecycle: "detached",
    lifecycleSource: "probe",
    projectPath: d.projectPath,
    projectName: d.projectName,
    branch: d.branch,
    lastOutput: "",
    elapsedMs: Date.now() - d.startedAt.getTime(),
    promptCount: 0,
    startedAt: d.startedAt.toISOString(),
    completedAt: null,
    ptyAttached: false,
    pid: d.pid,
  };
}
