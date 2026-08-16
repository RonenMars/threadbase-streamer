import {
  type Conversation,
  type ConversationMeta,
  ConversationScanner,
  type FileStatEntry,
} from "@threadbase-sh/scanner";
import { statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ConversationCache } from "./conversation-cache";
import type { CacheMetadataRepository } from "./db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "./db/repositories/conversations.repository";
import type { ProjectsRepository } from "./db/repositories/projects.repository";
import { getLogger } from "./logger";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER } from "./providers";
import { setCacheMetadata } from "./services/cache/cacheMetadata";
import type { CacheIntegrityMonitor } from "./services/cache-integrity/cacheIntegrityMonitor";
import { refreshConversationCache } from "./services/conversations/refreshConversationCache";
import { shouldRefreshProjectsFromHdd } from "./services/conversations/shouldRefreshProjectsFromHdd";
import {
  canonicalLivePathSet,
  joinStatCacheByNativePath,
  toNativeFilePath,
} from "./utils/canonicalizeFilePath";
import { debounce } from "./utils/debounce";
import { isScannedSnapshotStale } from "./utils/isScannedSnapshotStale";

// A refresh that settled within this window is served from the current
// snapshot instead of re-parsing.
const REFRESH_TTL_MS = 2000;

export type ConversationReconcileMode = "files" | "full";

export type ScanProfile = {
  id: string;
  label: string;
  configDir: string;
  enabled: boolean;
  emoji: string;
};

/**
 * Everything ScannerManager reads from the server. Nullable collaborators are
 * thunks rather than values because they are opened during listen() and
 * rebound by the integrity monitor's reset-and-rescan — the same reason
 * ApiDeps passes `cache: () => ConversationCache | null`.
 */
export type ScannerManagerDeps = {
  scanProfiles: ScanProfile[] | undefined;
  codexRoots: string[];
  directoryDebounceMs: number;
  persistenceDisabled: boolean;
  cache: () => ConversationCache | null;
  cacheMonitor: () => CacheIntegrityMonitor | null;
  projectsRepo: () => ProjectsRepository | null;
  conversationsRepo: () => ConversationsRepository | null;
  cacheMetadataRepo: () => CacheMetadataRepository | null;
  trackCacheWrite: (task: Promise<unknown>) => void;
};

/**
 * Owns the conversation scanner's lifecycle and freshness state: which scanner
 * instance is current, whether a scan is in flight, which files went stale, and
 * the cache↔disk reconcile that closes the gap.
 *
 * Extracted from StreamerServer so scanner work stops editing the server file
 * (see docs/plans/2026-07-12-server-ts-split.md, PR 2).
 */
export class ScannerManager {
  private scanner: ConversationScanner | null = null;
  private scannerReady: Promise<unknown> | null = null;
  private scannerStale = false;
  private persistenceDisabled: boolean;
  private allScanners = new Set<ConversationScanner>();
  private stalePaths = new Set<string>();
  private reconcileInFlight: Promise<void> | null = null;
  private lastAutoFullReconcileAt = 0;
  // reconcileMode() returns "full" on every poll while a permanent drift
  // condition holds (e.g. an orphan row) — without a cooldown each poll
  // re-walks the whole corpus back-to-back. refresh=1 and per-file
  // reconciles go through other paths and are unaffected.
  private static readonly AUTO_FULL_RECONCILE_COOLDOWN_MS = 60_000;
  private refreshInFlight = new Map<string, { promise: Promise<unknown>; completedAt: number }>();
  private log = getLogger("server");

  /**
   * Trailing-debounced "the directory changed" signal. Kept public because the
   * server wires it straight into the watcher callback and cancels it in
   * close(); `.cancel()` is part of its contract.
   */
  readonly markStaleDebounced: ReturnType<typeof debounce>;

  constructor(private deps: ScannerManagerDeps) {
    this.persistenceDisabled = deps.persistenceDisabled;
    this.markStaleDebounced = debounce(() => {
      if (this.scannerReady) {
        // Only arm when paths remain. takeStaleFiles may have drained them
        // while this debounce was pending; re-arming then would leave
        // scannerStale=true with an empty set, and the next "files" reconcile
        // would silently upgrade into a full-tree rescan (#409).
        if (this.stalePaths.size > 0) this.scannerStale = true;
      }
      // No adopted scanner yet, so there are no in-place indexes to refresh —
      // drop it and let the next get() build one. The recorded paths go with
      // it; the fresh scan covers them.
      else {
        this.scanner = null;
        this.stalePaths.clear();
      }
    }, deps.directoryDebounceMs);
  }

  // ─── state accessors ──────────────────────────────────────────────

  /** The current scanner without triggering a scan; null before the first one. */
  get current(): ConversationScanner | null {
    return this.scanner;
  }

  /** The in-flight (or settled) scan promise; null when no scanner was ever built. */
  get ready(): Promise<unknown> | null {
    return this.scannerReady;
  }

  get stale(): boolean {
    return this.scannerStale;
  }

  set stale(value: boolean) {
    this.scannerStale = value;
  }

  /** The stale-path set itself, so callers can add/clear/size it in place. */
  get staleFiles(): Set<string> {
    return this.stalePaths;
  }

  /** Drop the current scanner so the next get() builds a fresh one. */
  invalidate(): void {
    this.scanner = null;
    this.scannerReady = null;
  }

  /**
   * A new JSONL bound to a live session: the index must pick it up.
   *
   * Arm the stale flag when a scan already exists, so the next get() reconciles
   * in place. With no scanner yet there is nothing to mark, so drop it instead
   * and let the next get() build one. Exactly one of the two happens — dropping
   * the scanner in both cases would throw away a live index on every bind.
   */
  markStaleOrDrop(): void {
    if (this.scannerReady) {
      this.scannerStale = true;
    } else {
      this.scanner = null;
    }
  }

  /** Persistent indexes are disabled for the rest of this process's life. */
  disablePersistence(): void {
    this.persistenceDisabled = true;
  }

  /** Track a scanner the server built itself so close() still tears it down. */
  track(scanner: ConversationScanner): void {
    this.allScanners.add(scanner);
  }

  /**
   * Adopt the warm-up scanner as the live one, but only if nothing else claimed
   * the slot while the warm-up scan ran.
   */
  adoptIfUnclaimed(scanner: ConversationScanner): boolean {
    if (this.scannerReady || this.scanner) return false;
    this.scanner = scanner;
    this.scannerReady = Promise.resolve();
    return true;
  }

  // ─── construction helpers ─────────────────────────────────────────

  buildStatCache(
    previousScanner: ConversationScanner | null,
  ): Map<string, { stat: FileStatEntry; meta: ConversationMeta }> | undefined {
    const cache = this.deps.cache();
    if (!cache) return undefined;
    // The scanner looks statCache entries up by its own ConversationMeta
    // .filePath, which is native-separator. Cache rows are canonical. So every
    // join below compares canonical forms, but the returned map is always keyed
    // native — otherwise the scanner misses every entry on Windows and silently
    // re-parses every conversation on each rescan.
    if (!previousScanner) {
      const persisted = cache.getScannerStatCache();
      if (persisted.size === 0) return undefined;
      const nativeKeyed = new Map<string, { stat: FileStatEntry; meta: ConversationMeta }>();
      for (const [canonicalPath, entry] of persisted) {
        nativeKeyed.set(toNativeFilePath(canonicalPath), entry);
      }
      return nativeKeyed;
    }
    const dbStats = cache.getFileStats();
    if (dbStats.size === 0) return undefined;
    const statCache = joinStatCacheByNativePath(
      previousScanner.getMetadataCache().values(),
      dbStats,
    );
    return statCache.size > 0 ? statCache : undefined;
  }

  // Returns the provider + codexRoots fragment to spread into every scan()/search() call.
  // codexRoots=[] disables codex scanning (safe no-op per scanner contract).
  codexScanOpts() {
    return {
      providers: [CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER],
      codexRoots: this.deps.codexRoots,
    };
  }

  newScanner(options?: ConstructorParameters<typeof ConversationScanner>[0]): ConversationScanner {
    return new ConversationScanner(
      options ?? (this.persistenceDisabled ? { persistent: false } : undefined),
    );
  }

  /**
   * The projects dirs disk discovery should walk — the single source of truth
   * for "where do this server's JSONLs live", mirroring the warm-up watcher
   * (see listen()). Derived from the enabled scanProfiles' configDirs, or the
   * real ~/.claude/projects when no profiles are configured. An all-disabled
   * profile set intentionally yields [] (nothing to discover), matching the
   * watcher — it does NOT fall back to home in that case.
   */
  projectsDirs(): string[] {
    const profiles = this.deps.scanProfiles;
    if (profiles && profiles.length > 0) {
      return profiles.filter((p) => p.enabled).map((p) => join(p.configDir, "projects"));
    }
    return [join(homedir(), ".claude", "projects")];
  }

  // ─── staleness ────────────────────────────────────────────────────

  // Drain the stale set and disarm the flag together. The caller owns the
  // returned paths: clearing before the refresh means events that land DURING
  // it re-arm the flag and get their own pass instead of being swallowed.
  takeStaleFiles(): string[] {
    const paths = [...this.stalePaths];
    this.stalePaths.clear();
    this.scannerStale = false;
    return paths;
  }

  // Reconcile exactly the JSONLs a directory event named. Failures are logged
  // and swallowed per file: one unreadable transcript must not abort the
  // others, and the file simply stays on its previous snapshot until the next
  // event — the same outcome the full rescan gave on a parse failure.
  async refreshStaleFiles(
    scanner: ConversationScanner,
    paths: string[],
  ): Promise<ConversationMeta[]> {
    const metas = await Promise.all(
      paths.map((filePath) =>
        scanner.refreshFile(filePath).catch((err) => {
          this.log.warn("scanner.refreshFile: failed", {
            event: "scanner.refresh_failed",
            filePath,
            trigger: "directory-event",
            err,
          });
          return null;
        }),
      ),
    );
    return metas.filter((m): m is ConversationMeta => m !== null);
  }

  // True when the JSONL on disk is meaningfully newer than the scanned
  // snapshot's last-activity timestamp — i.e. the file grew after the scan.
  isConversationSnapshotStale(conv: Conversation): boolean {
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
  refreshFileGuarded(
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

  // ─── scanner acquisition ──────────────────────────────────────────

  // skipStaleRescan: when an indexed scanner already exists, return it directly
  // even if scannerStale is set, leaving the flag untouched so the next
  // list-level call still rescans. The single-conversation detail path passes
  // this — its per-file refreshFile (in findConversationByUuid) already
  // reconciles the one conversation being requested, so paying a full-tree
  // rescan just because some OTHER file changed is the stall this avoids.
  async get(skipStaleRescan = false): Promise<ConversationScanner> {
    // Detail path (#368): never block on an in-flight scan. The live scanner is
    // kept readable across full rescans (shadow-and-swap in rescanForRefresh);
    // mid-rebuild the previous generation is still correct for conversations
    // that existed before the rescan started.
    if (skipStaleRescan && this.scanner) {
      return this.scanner;
    }
    if (this.scannerReady) {
      await this.scannerReady;
      // onConversationChanged may have nulled this.scanner while we awaited —
      // if so, fall through and create a fresh one.
      if (this.scanner) {
        if (skipStaleRescan) return this.scanner;
        // If file events arrived while the scan was running, reconcile now
        // rather than serving a stale result — but per file, not by discarding
        // the instance. refreshFile() re-indexes exactly the named JSONL and
        // touches only that file's conversationLRU keys, so an append to one
        // conversation can no longer evict every other conversation's parsed
        // snapshot. Paths are drained first so events arriving during the
        // refresh re-arm the flag and get their own pass.
        if (this.scannerStale) {
          const paths = this.takeStaleFiles();
          // Armed with no paths ("stale, source unknown"): fall back to the
          // full rebuild, which is what the flag meant before it carried
          // identity.
          if (paths.length === 0) {
            this.scanner = null;
            this.scannerReady = null;
            return this.get();
          }
          await this.refreshStaleFiles(this.scanner, paths);
          return this.scanner ?? this.get();
        }
        return this.scanner;
      }
    }
    this.takeStaleFiles();
    const statCache = this.buildStatCache(this.scanner);
    // Scanner 0.9.4 reads statCache only in non-persistent scans.
    this.scanner = this.newScanner(statCache ? { persistent: false } : undefined);
    this.allScanners.add(this.scanner);
    this.scannerReady = this.scanner.scan({
      ...(this.deps.scanProfiles ? { profiles: this.deps.scanProfiles } : {}),
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
    if (!scanner) return this.get();
    return scanner;
  }

  async getFresh(): Promise<ConversationScanner> {
    this.scanner = null;
    this.scannerReady = null;
    return this.get();
  }

  // refresh=1's scan: build a SHADOW scanner with fullRescan:true, then swap
  // it in atomically. The escape hatch bypasses the scanner's dir-mtime
  // discovery gate (an explicit user pull-to-refresh is exactly the "don't
  // trust the gate, check disk for real" signal).
  //
  // Scanning in place would clear the non-persistent scanner's metadataCache
  // at start, so a concurrent detail fetch that skipped the await would 404 a
  // conversation that exists — and one that awaited would pay the full scan's
  // wall clock (#368). Shadow-and-swap keeps this.scanner readable as the
  // previous generation for the whole rebuild.
  async rescanForRefresh(
    onProgress?: (scanned: number, total: number) => void,
  ): Promise<ConversationScanner> {
    // Let any in-flight scan finish first so we don't run two scans on the same
    // index concurrently.
    if (this.scannerReady) await this.scannerReady;
    // A full rescan supersedes any pending staleness, per-file paths included.
    this.takeStaleFiles();
    const previous = this.scanner;
    const statCache = this.buildStatCache(previous);
    const shadow = this.newScanner(statCache ? { persistent: false } : undefined);
    this.allScanners.add(shadow);
    this.scannerReady = shadow.scan({
      ...(this.deps.scanProfiles ? { profiles: this.deps.scanProfiles } : {}),
      ...this.codexScanOpts(),
      fullRescan: true,
      ...(statCache ? { statCache } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
    try {
      await this.scannerReady;
    } catch (err) {
      // Leave this.scanner as the previous generation; clear the failed promise
      // so the next caller retries rather than replaying the rejection.
      this.scannerReady = null;
      throw err;
    }
    this.scanner = shadow;
    return shadow;
  }

  // ─── cache ↔ disk reconcile ───────────────────────────────────────

  /**
   * Full-glob scan + cache upsert/delete reconcile. Used by ?refresh=1 and by
   * the automatic freshness path when the directory watcher marked the scanner
   * stale or shouldRefreshProjectsFromHdd detected disk drift.
   */
  async reconcileFromDisk(onProgress?: (scanned: number, total: number) => void): Promise<void> {
    const cache = this.deps.cache();
    if (!cache) return;
    // No warm-up gate here: the caller decides. The cold-start path wraps this
    // in withWarmup (nothing to serve, so 503 while building is correct); the
    // routine background path must NOT gate, or every JSONL append flips the
    // server into SERVER_WARMING_UP and the client flickers.
    const scanner = await this.rescanForRefresh(onProgress);
    const metas = [...scanner.getMetadataCache().values()];
    try {
      cache.upsertFromScannerMeta(metas as any[]);
      // Additions/updates are always safe. But while a cache-integrity alert
      // is pending, freeze the removal half — reconcileDeletions must not
      // drop rows until a human resolves the alert.
      if (!this.deps.cacheMonitor()?.pending) {
        // Canonical, because reconcileDeletions compares against
        // conversation_meta.file_path while the scanner's filePath is native.
        cache.reconcileDeletions(canonicalLivePathSet(metas));
      }
      const projectsRepo = this.deps.projectsRepo();
      const conversationsRepo = this.deps.conversationsRepo();
      const cacheMetadataRepo = this.deps.cacheMetadataRepo();
      if (projectsRepo && conversationsRepo && cacheMetadataRepo) {
        refreshConversationCache({
          cache,
          projectsRepo,
          conversationsRepo,
          cacheMetadataRepo,
        });
      } else if (cacheMetadataRepo) {
        setCacheMetadata(
          cacheMetadataRepo,
          "conversations_last_indexed_at",
          new Date().toISOString(),
        );
      }
    } catch (err) {
      this.log.warn(
        `refresh reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        { event: "conversations.reconcile_failed" },
      );
    }
  }

  // Reconcile the cache from disk without blocking the caller. Single-flighted
  // so a burst of list polls during active session writes shares one rescan
  // rather than queueing a full rescan each; tracked so close() awaits the
  // in-flight cache write before shutting the DB.
  startBackgroundReconcile(mode: ConversationReconcileMode = "full"): void {
    if (this.reconcileInFlight) return;
    if (mode === "full") {
      const now = Date.now();
      if (now - this.lastAutoFullReconcileAt < ScannerManager.AUTO_FULL_RECONCILE_COOLDOWN_MS) {
        return;
      }
      this.lastAutoFullReconcileAt = now;
    }
    const paths = mode === "files" ? this.takeStaleFiles() : [];
    const task = (
      paths.length > 0 ? this.reconcileStaleFilesFromDisk(paths) : this.reconcileFromDisk()
    ).finally(() => {
      this.reconcileInFlight = null;
    });
    this.reconcileInFlight = task;
    this.deps.trackCacheWrite(task);
  }

  // "files": a directory event named specific JSONLs, so refresh only those.
  // "full": disk drifted in ways a per-file refresh can't see (a project dir
  // appeared, rows vanished), so walk the tree. Order matters — the staleness
  // check short-circuits first so the HDD freshness probe stays off the hot
  // poll path, exactly as it did when this returned a boolean.
  reconcileMode(): ConversationReconcileMode | null {
    if (!this.deps.cache()) return null;
    if (this.scannerStale) return "files";
    const conversationsRepo = this.deps.conversationsRepo();
    const cacheMetadataRepo = this.deps.cacheMetadataRepo();
    if (!conversationsRepo || !cacheMetadataRepo) return null;
    return shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, {
      projectsDirs: this.projectsDirs(),
    })
      ? "full"
      : null;
  }

  // The per-file half of reconcileFromDisk: re-index just the changed JSONLs
  // and upsert their rows. No reconcileDeletions here — that needs the whole
  // live-path set, and deletions already have their own path (onFileDeleted ->
  // invalidateByFilePath). New projects still arrive via the HDD-freshness
  // "full" mode.
  private async reconcileStaleFilesFromDisk(paths: string[]): Promise<void> {
    const cache = this.deps.cache();
    if (!cache) return;
    const scanner = await this.get(true);
    const metas = await this.refreshStaleFiles(scanner, paths);
    if (metas.length === 0) return;
    try {
      cache.upsertFromScannerMeta(metas as any[]);
    } catch (err) {
      this.log.warn(
        `stale-file reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        { event: "conversations.reconcile_failed" },
      );
    }
  }

  // ─── teardown ─────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.markStaleDebounced.cancel();
    await Promise.all([...this.allScanners].map((s) => s.close()));
    this.allScanners.clear();
    this.scanner = null;
  }
}
