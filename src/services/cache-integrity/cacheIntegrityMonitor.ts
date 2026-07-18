// CacheIntegrityMonitor — detects cache/disk drift (missing JSONLs), freezes
// automatic pruning while a decision is pending, backs up the DB before any
// destructive resolution, and applies exactly the action a human chose, once,
// idempotently. See docs/superpowers/specs/2026-07-18-cache-integrity-alert-design.md.

import { createHash } from "crypto";
import { existsSync } from "fs";
import type { ConversationCache, ScannerMeta } from "../../conversation-cache";
import type { Logger } from "../../logger";
import type { CacheAlertResolveAction, WSMessage } from "../../types";
import type { WSHub } from "../../ws-hub";
import {
  type AlertState,
  loadAlertState,
  type MissingEntry,
  type PendingAlert,
  saveAlertState,
} from "./alertStore";
import { backupCacheDb } from "./backup";

export type ResolveAction = CacheAlertResolveAction;

/** The `cache_alert` WS variant, narrowed from the WSMessage union. */
export type CacheAlertWsMessage = Extract<WSMessage, { type: "cache_alert" }>;

export type ResolveResult =
  | { ok: true; action: ResolveAction; pruned?: number; backupPath?: string }
  | { alreadyResolved: true }
  | { conflict: true; currentFingerprint: string };

const MAX_MISSING_PERSISTED = 1000;
const SAMPLE_SIZE = 20;
const STORM_WINDOW_MS = 30_000;
const STORM_THRESHOLD = 10;

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** sha256 of the sorted missing-id list — stable identity for a missing-set. */
function fingerprintOf(ids: string[]): string {
  const sorted = [...ids].sort();
  return `sha256:${createHash("sha256").update(sorted.join("\n")).digest("hex")}`;
}

export class CacheIntegrityMonitor {
  private _pending: PendingAlert | null;
  private ignoredIds: Set<string>;
  private deferredUnlinks: string[] = [];
  private unlinkTimes: number[] = [];

  constructor(
    private readonly cache: ConversationCache,
    private readonly wsHub: WSHub,
    private readonly log: Logger,
    private readonly cacheDir: string,
    // Injected so reset_rescan can rebuild from disk truth without the monitor
    // depending on the whole server. Returns the metas a fresh scan surfaced.
    private readonly rescan?: () => Promise<ScannerMeta[]>,
  ) {
    const state = loadAlertState();
    this._pending = state.pending ?? null;
    this.ignoredIds = new Set(state.ignoredIds ?? []);
  }

  get pending(): PendingAlert | null {
    return this._pending;
  }

  private persist(): void {
    const state: AlertState = {};
    if (this._pending) {
      state.pending = {
        ...this._pending,
        missing: this._pending.missing.slice(0, MAX_MISSING_PERSISTED),
      };
    }
    if (this.ignoredIds.size > 0) state.ignoredIds = [...this.ignoredIds];
    saveAlertState(state);
  }

  private classifySeverity(missingCount: number, totalRows: number): "high" | "low" {
    const minMissing = envInt("THREADBASE_CACHE_ALERT_MIN_MISSING", 20);
    const minRatio = Number.parseFloat(process.env.THREADBASE_CACHE_ALERT_MIN_RATIO ?? "0.20");
    const ratio = totalRows > 0 ? missingCount / totalRows : 0;
    const ratioThreshold = Number.isFinite(minRatio) ? minRatio : 0.2;
    return missingCount >= minMissing && ratio >= ratioThreshold ? "high" : "low";
  }

  private sampleOf(missing: MissingEntry[]): { id: string; title?: string }[] {
    return missing.slice(0, SAMPLE_SIZE).map((m) => ({
      id: m.id,
      ...(m.title != null ? { title: m.title } : {}),
    }));
  }

  private buildWsMessage(pending: PendingAlert): CacheAlertWsMessage {
    return {
      type: "cache_alert",
      fingerprint: pending.fingerprint,
      severity: pending.severity,
      missingCount: pending.missingCount,
      totalRows: pending.totalRows,
      detectedAt: pending.detectedAt,
      sample: this.sampleOf(pending.missing),
    };
  }

  wsMessage(): CacheAlertWsMessage | null {
    return this._pending ? this.buildWsMessage(this._pending) : null;
  }

  healthzField():
    | { severity: "high" | "low"; missingCount: number; fingerprint: string; detectedAt: string }
    | undefined {
    if (!this._pending) return undefined;
    return {
      severity: this._pending.severity,
      missingCount: this._pending.missingCount,
      fingerprint: this._pending.fingerprint,
      detectedAt: this._pending.detectedAt,
    };
  }

  /**
   * Scan the cache for rows whose file is gone, excluding ids the user chose to
   * ignore. If none remain, clear any stale pending alert and return (the caller
   * decides whether to run pruneGhostFiles). Otherwise classify severity, persist
   * the pending record, back up on high severity, and broadcast the alert.
   */
  async runDetection(detectedAt: string = new Date().toISOString()): Promise<void> {
    const all = this.cache.listMissingFiles(existsSync);
    const missing = all.filter((m) => !this.ignoredIds.has(m.id));

    if (missing.length === 0) {
      if (this._pending) {
        this._pending = null;
        this.persist();
      }
      return;
    }

    const totalRows = this.cache.listConversations({ limit: 0, offset: 0 }).total;
    const fingerprint = fingerprintOf(missing.map((m) => m.id));
    const severity = this.classifySeverity(missing.length, totalRows);

    const pending: PendingAlert = {
      fingerprint,
      severity,
      detectedAt,
      missingCount: missing.length,
      totalRows,
      missing,
    };

    if (severity === "high") {
      try {
        pending.backupPath = await backupCacheDb(this.cache.getDatabase(), this.cacheDir);
      } catch (err) {
        this.log.warn("cache-integrity backup failed", {
          event: "cache_integrity.backup_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this._pending = pending;
    this.persist();
    this.log.warn("cache integrity drift detected", {
      event: "cache_integrity.detected",
      severity,
      missingCount: missing.length,
      totalRows,
      fingerprint,
    });
    this.wsHub.broadcast(this.buildWsMessage(pending));
  }

  /** Queue an unlink while an alert is pending — the row is not invalidated. */
  deferUnlink(filePath: string): void {
    this.deferredUnlinks.push(filePath);
  }

  /**
   * Record a live unlink while NO alert is pending. Crossing the storm threshold
   * (>= 10 unlinks within 30s) re-triggers detection.
   */
  recordUnlink(filePath: string): void {
    const now = Date.now();
    this.unlinkTimes.push(now);
    this.unlinkTimes = this.unlinkTimes.filter((t) => now - t < STORM_WINDOW_MS);
    if (this.unlinkTimes.length >= STORM_THRESHOLD) {
      this.unlinkTimes = [];
      void this.runDetection().catch((err) => {
        this.log.error("cache-integrity storm detection failed", {
          event: "cache_integrity.storm_detection_failed",
          error: err instanceof Error ? err.message : String(err),
          filePath,
        });
      });
    }
  }

  private async ensureBackup(pending: PendingAlert): Promise<string | undefined> {
    if (pending.backupPath) return pending.backupPath;
    try {
      pending.backupPath = await backupCacheDb(this.cache.getDatabase(), this.cacheDir);
    } catch (err) {
      this.log.warn("cache-integrity backup failed", {
        event: "cache_integrity.backup_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return pending.backupPath;
  }

  private clearPending(): void {
    this._pending = null;
    this.deferredUnlinks = [];
    this.persist();
  }

  private applyDeferredUnlinks(): void {
    for (const fp of this.deferredUnlinks) this.cache.invalidateByFilePath(fp);
    this.deferredUnlinks = [];
  }

  private broadcastResolved(fingerprint: string, action: ResolveAction): void {
    this.wsHub.broadcast({ type: "cache_alert_resolved", fingerprint, action });
  }

  /**
   * Apply the human's chosen resolution. Idempotent per fingerprint: no pending
   * alert → alreadyResolved; a different fingerprint → conflict. See the spec's
   * four-action semantics.
   */
  async resolve(
    fingerprint: string,
    action: ResolveAction,
    ids?: string[],
  ): Promise<ResolveResult> {
    const pending = this._pending;
    if (!pending) return { alreadyResolved: true };
    if (pending.fingerprint !== fingerprint) {
      return { conflict: true, currentFingerprint: pending.fingerprint };
    }
    // Claim the alert synchronously — before the first `await` below (backup is
    // async). A concurrent same-fingerprint resolve then sees no pending alert
    // and no-ops with `alreadyResolved`, upholding the spec's "first resolver
    // wins, second harmlessly no-ops" invariant across the await points.
    this._pending = null;

    switch (action) {
      case "prune_all": {
        await this.ensureBackup(pending);
        const backupPath = pending.backupPath;
        // Re-verify each id against disk — a file may have reappeared.
        const stillMissing = pending.missing
          .filter((m) => !existsSync(m.filePath))
          .map((m) => m.id);
        const pruned = this.cache.dropRowsById(stillMissing);
        this.applyDeferredUnlinks();
        this.clearPending();
        this.broadcastResolved(fingerprint, action);
        return { ok: true, action, pruned, backupPath };
      }

      case "prune_selected": {
        const requested = new Set(ids ?? []);
        const pendingIds = new Set(pending.missing.map((m) => m.id));
        // Intersect: only drop ids that are actually in the pending set.
        const toDrop = [...requested].filter((id) => pendingIds.has(id));
        await this.ensureBackup(pending);
        const backupPath = pending.backupPath;
        const pruned = this.cache.dropRowsById(toDrop);
        // Drain only the deferred unlinks for the pruned subset.
        const prunedPaths = new Set(
          pending.missing.filter((m) => toDrop.includes(m.id)).map((m) => m.filePath),
        );
        this.deferredUnlinks = this.deferredUnlinks.filter((fp) => {
          if (prunedPaths.has(fp)) {
            this.cache.invalidateByFilePath(fp);
            return false;
          }
          return true;
        });
        // Re-run detection on the remainder; a still-missing set raises a new
        // alert. (_pending was already cleared at the top of resolve.)
        this.persist();
        await this.runDetection();
        this.broadcastResolved(fingerprint, action);
        return { ok: true, action, pruned, backupPath };
      }

      case "ignore": {
        // Persist the individual ids (not the fingerprint) so one more deletion
        // doesn't resurface these — see spec rationale.
        for (const m of pending.missing) this.ignoredIds.add(m.id);
        // Discard the deferred queue: the user chose to keep these rows, so
        // queued deletions for other paths must not be applied as a side effect.
        this.deferredUnlinks = [];
        this.clearPending();
        this.broadcastResolved(fingerprint, action);
        return { ok: true, action };
      }

      case "reset_rescan": {
        const backupPath = await this.ensureBackup(pending);
        this.cache.clearAll();
        if (this.rescan) {
          try {
            const metas = await this.rescan();
            this.cache.upsertFromScannerMeta(metas);
          } catch (err) {
            this.log.error("cache-integrity reset rescan failed", {
              event: "cache_integrity.reset_rescan_failed",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        this.clearPending();
        this.broadcastResolved(fingerprint, action);
        return { ok: true, action, backupPath };
      }
    }
  }
}
