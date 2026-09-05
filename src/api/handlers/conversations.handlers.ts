import {
  applyIncludeFilter,
  applyPagination,
  applyProjectFilter,
  applySort,
  type Conversation,
  type ConversationMeta,
  type SearchMatch,
  type SortOrder,
  search,
} from "@threadbase-sh/scanner";
import { createReadStream, existsSync, readdirSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { basename, join } from "path";
import { createInterface } from "readline";
import { ConversationCache } from "../../conversation-cache";
import type { LiveSessionManager } from "../../live-session-manager";
import type { Logger } from "../../logger";
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_CLI_PROVIDER,
  coerceProviderForRunner,
  isProviderResumable,
} from "../../providers";
import type { ScannerManager, ScanProfile } from "../../scanner-manager";
import {
  findSearchTarget,
  type SearchableMessage,
} from "../../services/conversations/findSearchTarget";
import { deriveProjectChatTitle } from "../../services/projectChats/deriveProjectChatTitle";
import {
  applyFilters,
  type ParsedSearchQuery,
  paginate,
  parseSearchQuery,
  SearchQueryError,
} from "../../services/search/searchQuery";
import type { SessionStore } from "../../session-store";
import type { ManagedSession, ServerWarmupState } from "../../types";
import { isCodexInjectedContext } from "../../utils/codexConversationLine";
import { computeConversationEtag } from "../../utils/conversationEtag";
import { createScanProgressThrottle } from "../../utils/scanProgressThrottle";
import type { WSHub } from "../../ws-hub";
import { classifyResumability, intParam, json, readBody } from "./http-helpers";

// Search filters are applied after the scanner returns, so we ask it for more
// than one page. The multiplier bounds the common case; SEARCH_MAX_SCAN caps a
// broad query so it cannot pull an unbounded result set into memory.
const SEARCH_OVERFETCH = 4;
const SEARCH_MAX_SCAN = 1000;

// Ceiling on the `max_bytes` page budget. The number a client asks for is its
// own business — this only stops a typo'd extra zero from turning into a
// multi-hundred-MB response. Above the largest conversation observed locally
// (22.8 MB), so it clamps mistakes rather than legitimate requests.
const MAX_BYTES_CEILING = 32 * 1024 * 1024;

/**
 * Everything ConversationHandlers reads from the server. Collaborators
 * constructed once in the server constructor are passed by reference; anything
 * bound later (the cache opens during listen() and is rebound by the integrity
 * monitor's reset-and-rescan) or swapped by tests (`log`) is a thunk, for the
 * same reason ApiDeps passes `cache: () => ConversationCache | null`.
 *
 * The warm-up gate, the cache-write tracker and the three conversation-id
 * resolvers stay late-bound calls back into the server rather than moved code:
 * they read state (`activeWarmups`, `inFlightCacheWrites`, `sessionFileMap`)
 * that spans well beyond conversations.
 */
export type ConversationHandlersDeps = {
  scannerManager: ScannerManager;
  sessionStore: SessionStore;
  ptyManager: LiveSessionManager;
  wsHub: WSHub;
  scanProfiles: ScanProfile[] | undefined;
  cache: () => ConversationCache | null;
  log: () => Logger;
  rejectIfWarmingUp: (res: ServerResponse) => boolean;
  withWarmup: <T>(state: ServerWarmupState, operation: () => Promise<T>) => Promise<T>;
  trackCacheWrite: (task: Promise<unknown>) => void;
  resolveConversationLookupId: (uuid: string) => string;
  findLiveSessionFilePath: (uuid: string) => string | null;
  isBoundConversationLive: (boundId: string) => boolean;
};

/**
 * The conversation read surface: listing, counting, project summaries, the
 * single-conversation detail fetch (pagination + ETag + stale-while-revalidate)
 * and search — plus the JSONL/cwd resolvers the resume and adopt paths share.
 *
 * Extracted from StreamerServer so conversation work stops editing the server
 * file (see docs/plans/2026-07-12-server-ts-split.md, PR 4). State stays on the
 * server: this class only reads it through `deps`.
 */
export class ConversationHandlers {
  constructor(private deps: ConversationHandlersDeps) {}

  private get scannerManager(): ScannerManager {
    return this.deps.scannerManager;
  }

  private get sessionStore(): SessionStore {
    return this.deps.sessionStore;
  }

  private get ptyManager(): LiveSessionManager {
    return this.deps.ptyManager;
  }

  private get wsHub(): WSHub {
    return this.deps.wsHub;
  }

  private get scanProfiles(): ScanProfile[] | undefined {
    return this.deps.scanProfiles;
  }

  private get cache(): ConversationCache | null {
    return this.deps.cache();
  }

  private get log(): Logger {
    return this.deps.log();
  }

  async handleListConversations(url: URL, res: ServerResponse): Promise<void> {
    if (this.deps.rejectIfWarmingUp(res)) return;

    const limit = intParam(url, "limit", 50);
    const offset = intParam(url, "offset", 0);
    const sort = (url.searchParams.get("sort") ?? "recent") as SortOrder;
    const project = url.searchParams.get("project") ?? undefined;
    const providerFilter = url.searchParams.get("provider") ?? undefined;
    const bustCache = url.searchParams.get("refresh") === "1";

    // Reconcile (not wipe): fullRescan bypasses the scanner dir-mtime gate, then
    // upsert what exists and drop rows whose files are gone. Triggered by
    // explicit ?refresh=1, directory-watcher scannerStale, or HDD freshness drift.
    //
    // Never block the response on a routine reconcile. A full rescan takes
    // seconds on a large history, and active sessions trip scannerStale on
    // every JSONL append — so awaiting here stalls the list on every write.
    // Serve what is cached now and revalidate on disk in the background; the
    // next poll sees the fresh data (stale-while-revalidate). Block only when
    // there is nothing to serve (cold cache) or the caller asked for fresh data
    // explicitly with ?refresh=1.
    const reconcileMode = this.scannerManager.reconcileMode();
    if (this.cache && (bustCache || reconcileMode)) {
      const canServeStale =
        !bustCache && this.cache.listConversations({ limit: 0, offset: 0 }).total > 0;
      if (canServeStale) {
        this.scannerManager.startBackgroundReconcile(reconcileMode ?? "full");
      } else {
        // Cold cache (or explicit refresh): nothing to serve, so gate with the
        // warm-up state — the client shows the one-time "building history"
        // screen instead of an empty list — and await the build. Emit throttled
        // scan_progress so the client renders a live progress bar during the
        // wait instead of a frozen one; the routine background path above stays
        // silent (no onProgress) so normal-use polls never flicker a bar.
        const shouldEmitProgress = createScanProgressThrottle();
        await this.deps.withWarmup("conversation_refresh", () =>
          this.scannerManager.reconcileFromDisk((scanned, total) => {
            if (shouldEmitProgress(scanned, total)) {
              this.wsHub.broadcast({ type: "scan_progress", scanned, total });
            }
          }),
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

    const scanner = await this.scannerManager.get();
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

  async handleConversationsCount(url: URL, res: ServerResponse): Promise<void> {
    if (this.deps.rejectIfWarmingUp(res)) return;

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

    const scanner = await this.scannerManager.get(true);
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
    this.deps.trackCacheWrite(
      this.deps.withWarmup("conversation_refresh", async () => {
        try {
          const scanner = await this.scannerManager.getFresh();
          if (this.cache) {
            this.cache.upsertFromScannerMeta([...scanner.getMetadataCache().values()] as any[]);
          }
        } catch (err) {
          this.log.warn(
            `Background count refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            { event: "count.refresh_failed" },
          );
        }
      }),
    );
  }

  handleGetRecentSessions(url: URL, res: ServerResponse): void {
    if (this.deps.rejectIfWarmingUp(res)) return;
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
      ownership: "historical" as const,
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

  handleGetPopularProjects(url: URL, res: ServerResponse): void {
    const limit = intParam(url, "limit", 20);
    if (!this.cache) {
      json(res, 200, { projects: [], total: 0 });
      return;
    }
    const projects = this.cache.getPopularProjects(limit);
    json(res, 200, { projects, total: projects.length });
  }

  handleGetProjectSummaries(url: URL, res: ServerResponse): void {
    if (this.deps.rejectIfWarmingUp(res)) return;
    const limit = intParam(url, "limit", 200);
    const offset = intParam(url, "offset", 0);
    if (!this.cache) {
      // Deliberately not an empty 200: without the cache /api/conversations
      // falls back to the scanner and still returns rows, so "no projects"
      // would be a lie mobile draws an empty group tree from.
      json(res, 503, {
        error: "Conversation cache unavailable",
        code: "CACHE_UNAVAILABLE",
      });
      return;
    }
    const { projects, total } = this.cache.listProjectSummaries({ limit, offset });
    json(res, 200, { projects, total, offset, hasMore: offset + projects.length < total });
  }

  findJsonlPath(uuid: string): string | null {
    const filename = `${uuid}.jsonl`;
    for (const projectsDir of this.scannerManager.projectsDirs()) {
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

  /**
   * Resolve a conversation id to a JSONL path, in order of authority.
   *
   * `findJsonlPath` alone answers 64.0% of this machine's 961 conversations and
   * 0 of 343 Codex ones — it reconstructs `<projectsDir>/<dir>/<uuid>.jsonl`,
   * which is Claude Code's layout, and a Codex rollout is
   * `rollout-<ts>-<uuid>.jsonl` under a date path, so that walk cannot match one
   * by construction.
   *
   * That made the cache row the ONLY rung a Codex conversation could use, which
   * is why the scanner-index rung exists: measured 2026-09-04, 3 of the 50 ids
   * `GET /api/conversations` was serving 404'd here — every one a Codex rollout
   * present on disk, listed from the scanner index, with no cache row left. The
   * ladder's old "99.7%, only the file-is-gone case remains" held only while
   * every Codex row still had its cache entry.
   */
  async locateJsonlPath(uuid: string, lookupId: string): Promise<string | null> {
    // A live PTY owns its file; nothing on disk is more current.
    const live =
      this.deps.findLiveSessionFilePath(uuid) ?? this.deps.findLiveSessionFilePath(lookupId);
    if (live) return live;

    // The path the cache already recorded. Verified rather than trusted: 49 of
    // 961 rows on one machine pointed at a subagent transcript OF the
    // conversation instead of the conversation, so trusting this outright would
    // serve a 56-message sidechain as a 1307-message conversation.
    const cached = this.cache?.getMetaById(lookupId)?.filePath;
    if (cached && (await this.isJsonlPathFor(cached, lookupId))) return cached;

    // The scanner's own metadata index — literally the source the conversation
    // LIST reads (`getMetadataCache()`, used at handleListConversations). Without
    // this rung the list and the detail disagree: the list offers an id whose
    // parsed snapshot `getConversation` never built, and neither the cache row
    // (dropped) nor the Claude-layout walk (wrong shape) can name its file. Same
    // verification as the cached path; reading `current` never triggers a scan.
    const indexed = this.scannerManager.current?.getMetadataCache().get(lookupId)?.filePath;
    if (indexed && (await this.isJsonlPathFor(indexed, lookupId))) return indexed;

    // Claude-layout directory walk, kept as the self-heal for ids the cache
    // never learned about — and for the 49 above, where it happens to be right.
    return this.findJsonlPath(lookupId);
  }

  /**
   * Does `filePath` actually hold the conversation `requestedId` names?
   *
   * The filename settles it for both providers: Claude writes `<uuid>.jsonl`
   * (or `agent-<agentId>.jsonl`), Codex writes `rollout-<ts>-<uuid>.jsonl`.
   * Only when the name says nothing do we open the file — and there the naive
   * rule is wrong, because **a Claude subagent transcript carries the PARENT's
   * `sessionId`**. Matching on `sessionId` alone therefore verifies exactly the
   * file this check exists to reject, so a sidechain is refused outright unless
   * it was asked for by its own `agent-<agentId>` name, which the filename
   * branch above already covers.
   */
  async isJsonlPathFor(filePath: string, requestedId: string): Promise<boolean> {
    if (!existsSync(filePath)) return false;
    const stem = basename(filePath).replace(/\.jsonl$/, "");
    if (stem === requestedId || stem.includes(requestedId)) return true;

    const first = await this.readFirstJsonlEntry(filePath);
    if (!first || first.isSidechain === true) return false;
    return first.sessionId === requestedId;
  }

  /** First parseable JSONL line, for identity checks. Null on an empty or unreadable file. */
  async readFirstJsonlEntry(
    filePath: string,
  ): Promise<{ sessionId?: string; isSidechain?: boolean } | null> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      let done = false;
      rl.on("line", (line) => {
        if (done) return;
        try {
          const entry = JSON.parse(line);
          done = true;
          rl.close();
          resolve(entry as { sessionId?: string; isSidechain?: boolean });
        } catch {
          // skip malformed lines
        }
      });
      rl.on("close", () => {
        if (!done) resolve(null);
      });
      rl.on("error", () => resolve(null));
    });
  }

  async readCwdFromJsonl(filePath: string): Promise<string | null> {
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

  async findConversationByUuid(uuid: string): Promise<Conversation | null> {
    const lookupId = this.deps.resolveConversationLookupId(uuid);

    // Cold-start fast path: until the warm-up scan has populated this.scannerManager.current
    // (this.scannerManager.ready is null), do NOT trigger a full scan to answer a
    // single-conversation request — that scan walks every JSONL on disk and is
    // the 20s+ stall that makes mobile abort. Resolve the file directly
    // (findJsonlPath is an O(project-dirs) walk) and parse just that one file.
    // The warm-up scan keeps running in the background; once it adopts the
    // scanner, subsequent requests use the indexed hot path below.
    if (!this.scannerManager.ready && !this.scanProfiles) {
      const filePath = await this.locateJsonlPath(uuid, lookupId);
      if (filePath) {
        const account = this.cache?.getMetaById(lookupId)?.account ?? undefined;
        const coldScanner = this.scannerManager.current ?? this.scannerManager.newScanner();
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
    const scanner = await this.scannerManager.get(true);
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
        this.deps.isBoundConversationLive(lookupId)
      ) {
        // Codex live sessions: the scanner LRU snapshot is often frozen at bind
        // time (mtime always looks "live", so SWR never refreshes). Re-parse the
        // watched rollout so REST history includes turns written after bind.
        // Claude keeps the cheap bypass — its offset index + WS seq path stay fresh.
        const livePath =
          this.deps.findLiveSessionFilePath(uuid) ??
          this.deps.findLiveSessionFilePath(lookupId) ??
          fromIndex.filePath ??
          null;
        const isCodexLive =
          this.deps.isBoundConversationLive(lookupId) ||
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
      if (fromIndex.filePath && this.scannerManager.isConversationSnapshotStale(fromIndex)) {
        const filePath = fromIndex.filePath;
        this.deps.trackCacheWrite(
          this.scannerManager.refreshFileGuarded(scanner, filePath).catch((err) => {
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

    const filePath = await this.locateJsonlPath(uuid, lookupId);
    if (!filePath) return null;

    // Mid-full-rescan (or any in-flight scannerReady): do NOT discard the live
    // scanner and kick a competing getScanner() — that races the shadow rebuild
    // in rescanForRefresh. Parse just this one file the same way the cold-start
    // path does (#368).
    if (this.scannerManager.ready) {
      const account = this.cache?.getMetaById(lookupId)?.account ?? undefined;
      const singleFileScanner = this.scannerManager.current ?? this.scannerManager.newScanner();
      try {
        const page = await singleFileScanner.parseSingleFilePage(filePath, account, {
          limit: Number.MAX_SAFE_INTEGER,
        });
        if (page?.conversation) return page.conversation;
      } catch (err) {
        this.log.warn("detail.single_file_parse_failed", {
          event: "detail.single_file_parse_failed",
          conversationId: lookupId,
          filePath,
          err,
        });
      }
      return null;
    }

    this.scannerManager.invalidate();
    const freshScanner = await this.scannerManager.get();
    return freshScanner.getConversation(lookupId);
  }

  /**
   * The 200 body for a session that exists but has written no transcript yet.
   *
   * Same shape as the cache-tail fallback in handleGetConversation, with an
   * empty message list — a client cannot tell "no turns yet" from "a
   * conversation that happens to be empty", which is the point: both are a
   * working session with nothing to show, and neither is an error. There is no
   * `file_path` on purpose; the file does not exist yet.
   */
  private emptyConversationPayload(id: string, session: ManagedSession) {
    const provider = coerceProviderForRunner(session.provider);
    const availability = classifyResumability(session.projectPath);
    return {
      meta: {
        id,
        profile_id: session.account ?? undefined,
        project_name: session.projectName,
        session_name: session.sessionName ?? undefined,
        project_path: session.projectPath,
        last_updated_at: (session.lastActivityAt ?? session.startedAt).toISOString(),
        message_count: 0,
        provider,
        resumable: isProviderResumable(provider, availability.resumable),
        ...(availability.unavailable_reason && {
          unavailable_reason: availability.unavailable_reason,
        }),
      },
      messages: [] as unknown[],
      message_pagination: {
        total: 0,
        before_index: 0,
        from_index: 0,
        has_more_older: false,
        next_before_index: null,
      },
    };
  }

  async handleGetConversation(
    id: string,
    url: URL,
    res: ServerResponse,
    ifNoneMatch?: string,
  ): Promise<void> {
    if (this.deps.rejectIfWarmingUp(res)) return;

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
        const usableTail = (tail?.messages ?? []).filter(
          (message) => (message.text ?? "").length > 0 || (message.content?.length ?? 0) > 0,
        );
        if (usableTail.length > 0) {
          const cachedMeta = this.cache.getMetaById(id);
          const cachedProvider = cachedMeta?.provider ?? CLAUDE_CODE_PROVIDER;
          const availability = classifyResumability(cachedMeta?.projectPath);
          const messagesPayload = usableTail.map((m, idx) => ({
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
              session_name: cachedMeta?.title ?? undefined,
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
              total: usableTail.length,
              before_index: usableTail.length,
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
      // A session that has never been given a prompt is an EMPTY conversation,
      // not a missing one. Claude only creates `<sessionId>.jsonl` on the first
      // user turn — measured 0.0s to 86.9s after `pty.ready` on this machine, and
      // never at all if the user opens a session and walks away. 404 here was
      // 62% of every conversation 404 in a three-week production log, and it is
      // what renders "Messages failed to load" on a session that is working fine.
      // `promptCount === 0` is the same "unused start" signal
      // `shouldForgetEmptySession` uses, and it keeps a real deletion honest: a
      // session that HAS sent prompts but has no transcript still 404s.
      const unusedStart = this.sessionStore.getManaged(id);
      if (unusedStart && unusedStart.promptCount === 0) {
        json(res, 200, this.emptyConversationPayload(id, unusedStart));
        return;
      }

      // Self-heal, but only on PROOF. The row is a ghost when it names a file and
      // that file is gone. Dropping it on an unexplained miss was the bug that
      // made this permanent: for a Codex rollout the cache row is the only rung
      // of locateJsonlPath that can match, so one transient miss deleted the row,
      // the next request could no longer find the file, and `/api/sessions/:id`
      // lost the same row as its own fallback — both endpoints 404ing forever on
      // a conversation still sitting on disk. Invalidate `lookupId`, since that
      // is the id the row is keyed by; `id` may be a Codex placeholder.
      const lookupId = this.deps.resolveConversationLookupId(id);
      const rowPath = this.cache?.getMetaById(lookupId)?.filePath;
      if (rowPath && !existsSync(rowPath)) this.cache?.invalidate(lookupId);

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
      url.searchParams.has("max_bytes") ||
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
        // The one line that separates a fast fetch from a slow one. A miss
        // means this request falls through to the scanner and re-parses the
        // whole file, which is the entire difference between the 34 ms and
        // 2877 ms fetches of the same conversation — and it was invisible in
        // the log, because only the failure case was ever recorded.
        this.log.info(
          `[server] offset-index miss ${id} → scanner fallback`,
          {
            event: "offset_index.miss",
            conversationId: id,
            fromIndex: windowStart,
            toIndex: beforeIndex,
          },
          "pino",
        );
        // Cold/stale index for a file we page linearly → backfill in the
        // background (tracked so close() awaits it) for next time. The current
        // request is served by the scanner path below.
        this.deps.trackCacheWrite(
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

    // Byte budget. A page is bounded by `msg_limit` (capped at 500), but a
    // count says nothing about what actually lands in a phone's heap: locally
    // measured conversations run p50 315 KB and max 22.8 MB, so the same 500
    // messages can be two orders of magnitude apart in size. `max_bytes` drops
    // the OLDEST messages of the page until the rest fit, keeping the newest —
    // the client wants the tail, and it pages backward from there.
    //
    // No `truncated` flag: a trimmed page is exactly a page with older messages
    // behind it, which `has_more_older`/`next_before_index` already say. The
    // only genuinely new fact is what the budget spent, so that is all that is
    // added.
    const requestedMaxBytes = intParam(url, "max_bytes", 0);
    if (requestedMaxBytes > 0 && messagesPayload.length > 0) {
      const budget = Math.min(requestedMaxBytes, MAX_BYTES_CEILING);
      let used = 0;
      let firstKept = messagesPayload.length - 1;
      for (let i = messagesPayload.length - 1; i >= 0; i--) {
        // Bytes, not string length: a Hebrew or emoji-heavy conversation is up
        // to 4x its UTF-16 length on the wire, and undercounting is how a
        // budget silently stops binding for exactly the users it matters to.
        const size = Buffer.byteLength(JSON.stringify(messagesPayload[i]));
        // The newest message is served whatever its size — a blank screen is
        // worse than an over-budget one, and there is no smaller page to fall
        // back to.
        if (i < messagesPayload.length - 1 && used + size > budget) break;
        used += size;
        firstKept = i;
      }
      if (firstKept > 0) {
        messagesPayload.splice(0, firstKept);
        // message_index is absolute (fromIdx + localIdx at map time), so the
        // remaining entries keep their correct indices; only the page's own
        // start moves, and with it the cursor a client pages older from.
        if (messagePagination) {
          const newFrom = fromIdx + firstKept;
          messagePagination.from_index = newFrom;
          messagePagination.has_more_older = newFrom > 0;
          messagePagination.next_before_index = newFrom > 0 ? newFrom : null;
        }
      }
      if (messagePagination) messagePagination.served_bytes = used;
    }

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
        session_name: conv.sessionName || undefined,
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
  async handleSearchTarget(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    let parsed: ParsedSearchQuery;
    try {
      parsed = parseSearchQuery(url.searchParams);
    } catch (err) {
      if (err instanceof SearchQueryError) {
        json(res, 400, { error: err.message, code: err.code });
        return;
      }
      throw err;
    }
    const { q, limit, offset, filters } = parsed;
    const startedAt = Date.now();

    const scanner = await this.scannerManager.get();
    const results = await search(
      q,
      {
        // Fetch beyond the requested page: filters below are applied AFTER the
        // scanner returns, so slicing at `limit` here would drop results that a
        // later page should contain. Bounded so a broad query cannot pull an
        // unbounded set into memory.
        limit: Math.min(offset + limit * SEARCH_OVERFETCH, SEARCH_MAX_SCAN),
        include: "conversations",
        ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
        ...this.scannerManager.codexScanOpts(),
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
      // The scanner already computes relevance and match snippets; the previous
      // adapter discarded both, so results arrived in an unexplained order with
      // no indication of WHY anything matched.
      score: r.score,
      matches: Array.isArray(r.matches)
        ? r.matches.map((m: SearchMatch) => ({
            field: m.field,
            snippet: m.snippet,
            // Offsets into `snippet` for the matched tokens. Absent on metadata
            // hits, and on scanners older than the one that added them.
            highlights: m.highlights,
          }))
        : [],
    }));

    const page = paginate(applyFilters(adapted, filters), offset, limit);
    json(res, 200, {
      conversations: page.items,
      hasMore: page.hasMore,
      offset: page.offset,
      total: page.total,
      // Query timing, so a slow search is diagnosable rather than merely felt.
      tookMs: Date.now() - startedAt,
    });
  }
}
