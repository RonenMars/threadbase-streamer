import { statSync } from "fs";
import { ConversationCache } from "./conversation-cache";
import { getLogger } from "./logger";
import type { CacheIntegrityMonitor } from "./services/cache-integrity/cacheIntegrityMonitor";
import type { ConversationWatcher } from "./services/conversations/conversationWatcher";
import { RESUME_BUSY_WINDOW_MS } from "./services/sessions/conversationBusy";
import type { SessionActivity, SessionResponse } from "./types";
import { canonicalizeFilePath } from "./utils/canonicalizeFilePath";
import type { WSHub } from "./ws-hub";

// ─── External (non-PTY) live tails ───────────────────────────────────────────
// A JSONL that changes in a watched project directory while NOT owned by any
// PTY session belongs to an external agent (a terminal `claude`, another
// streamer, an IDE). Tail it explicitly so mobile gets pushed transcript lines
// for it instead of nothing.

// A directory event only attaches a tail when the file was touched this
// recently — the same "actively owned right now" window the resume collision
// probe uses, so both features agree on what "live" means.
export const EXTERNAL_TAIL_RECENCY_MS = RESUME_BUSY_WINDOW_MS;

// Hard cap on concurrent external tails; attaching past it LRU-evicts the
// least recently active one. Bounds chokidar handles on a machine with a large
// project tree (an unbounded map would attach one per touched JSONL).
export const EXTERNAL_TAIL_MAX = 32;

// An external tail with no appended lines for this long is detached — the
// external agent finished or moved on, and the directory watcher re-attaches
// if it starts writing again.
export const EXTERNAL_TAIL_IDLE_MS = 300_000; // 5 minutes

// A JSONL that grew within this window reads as "active_writing"; older reads as
// "quiet". Deliberately short — this is an inferred hint, not a status.
export const EXTERNAL_ACTIVE_WRITING_MS = 30_000;

export type ExternalTailEntry = { conversationId: string; lastActivityAt: number };

/**
 * Everything ExternalTailManager reads from the server. Nullable collaborators
 * are thunks rather than values because they are opened during listen() and
 * rebound by the integrity monitor's reset-and-rescan — the same reason
 * ApiDeps passes `cache: () => ConversationCache | null`.
 *
 * `tails` and `sessionFileMap` are the server's own Maps, held by reference:
 * the server still owns them as instance fields (both are reached directly
 * elsewhere in server.ts, and the tests read `externalTails` off the server),
 * this class only drives them.
 */
export type ExternalTailManagerDeps = {
  tails: Map<string, ExternalTailEntry>;
  sessionFileMap: Map<string, string>;
  fileWatcher: ConversationWatcher;
  wsHub: WSHub;
  cache: () => ConversationCache | null;
  cacheMonitor: () => CacheIntegrityMonitor | null;
  broadcastConversationLines: (
    sessionId: string,
    lines: string[],
    seqs?: (number | null)[] | null,
  ) => void;
};

/**
 * Owns the live tails on JSONLs no PTY session is writing: when one attaches,
 * when it is evicted or swept, the inferred activity it feeds into session
 * responses, and the transcript lines it pushes.
 *
 * Extracted from StreamerServer so external-tail work stops editing the server
 * file, continuing the split in docs/plans/2026-07-12-server-ts-split.md.
 */
export class ExternalTailManager {
  private log = getLogger("server");

  constructor(private deps: ExternalTailManagerDeps) {}

  private get externalTails(): Map<string, ExternalTailEntry> {
    return this.deps.tails;
  }

  /** True when a managed (PTY) session owns the tail for this canonical path. */
  isManagedTailPath(key: string): boolean {
    for (const watchedPath of this.deps.sessionFileMap.values()) {
      if (canonicalizeFilePath(watchedPath) === key) return true;
    }
    return false;
  }

  /**
   * Attach a live tail to a JSONL nobody is tailing yet, when it was touched
   * recently enough to look actively written by an external agent. Capped at
   * EXTERNAL_TAIL_MAX with LRU eviction.
   */
  maybeAttachExternalTail(filePath: string): void {
    if (!filePath.endsWith(".jsonl")) return;
    const key = canonicalizeFilePath(filePath);
    if (this.externalTails.has(key)) return;
    // A managed session's tail is owned by the PTY path; never shadow it.
    if (this.isManagedTailPath(key)) return;

    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      return; // unlink event, or unreadable — nothing to tail
    }
    const now = Date.now();
    // Only the UPPER bound matters: a just-written file can carry an mtime a
    // few ms in the future (timestamp granularity / clock skew).
    if (now - mtimeMs > EXTERNAL_TAIL_RECENCY_MS) return;

    this.evictExternalTailsIfNeeded();
    // The real conversation id is resolved from the cache row on the first
    // broadcast (codex rollout files aren't named after their id); the filename
    // stem is only a placeholder until then.
    this.externalTails.set(key, {
      conversationId: ConversationCache.conversationIdForFile(key),
      lastActivityAt: now,
    });
    this.deps.fileWatcher.watch(filePath);
    this.log.debug?.(`External tail attached: ${filePath}`, {
      filePath,
      tails: this.externalTails.size,
      event: "external_tail.attach",
    });
  }

  /** Stop tailing an external file and drop its bookkeeping. */
  detachExternalTail(key: string): void {
    if (!this.externalTails.delete(key)) return;
    this.deps.fileWatcher.unwatch(key);
    this.log.debug?.(`External tail detached: ${key}`, {
      filePath: key,
      event: "external_tail.detach",
    });
  }

  /**
   * Shared unlink path for the per-file watcher and the directory watcher.
   * Detaches any external tail and drops the cache row (unless an integrity
   * alert is freezing deletes).
   */
  handleJsonlDeleted(filePath: string): void {
    // The file is gone; an external tail on it can never fire again.
    this.detachExternalTail(canonicalizeFilePath(filePath));
    // While an alert is pending, freeze: queue the deletion instead of
    // invalidating the row, so an rm -rf mid-freeze can't drain the cache.
    if (this.deps.cacheMonitor()?.pending) {
      this.deps.cacheMonitor()?.deferUnlink(filePath);
      return;
    }
    const id = this.deps.cache()?.invalidateByFilePath(filePath);
    if (id)
      this.log.info(`Cache row invalidated after JSONL delete: ${id}`, {
        id,
        filePath,
        event: "cache.invalidate_on_unlink",
      });
    // Feed the storm detector — a burst of unlinks re-triggers detection.
    this.deps.cacheMonitor()?.recordUnlink(filePath);
  }

  /** Make room for one more tail by evicting the least recently active ones. */
  evictExternalTailsIfNeeded(): void {
    while (this.externalTails.size >= EXTERNAL_TAIL_MAX) {
      let lruKey: string | null = null;
      let lruAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.externalTails) {
        // A path a PTY session has since adopted is no longer ours: release the
        // bookkeeping WITHOUT closing the watcher the managed path now owns.
        if (this.isManagedTailPath(key)) {
          this.externalTails.delete(key);
          return;
        }
        if (entry.lastActivityAt < lruAt) {
          lruAt = entry.lastActivityAt;
          lruKey = key;
        }
      }
      if (!lruKey) return;
      this.detachExternalTail(lruKey);
    }
  }

  /**
   * INFERRED activity for an externally-owned conversation, derived purely from
   * how recently its JSONL grew (the external tail's bookkeeping). Returns
   * undefined when we hold no tail for it, so a session we know nothing about
   * reports no activity rather than a fabricated "quiet".
   *
   * This can never distinguish a generating agent from one blocked on a
   * permission gate — gates render on the PTY screen and never reach the JSONL —
   * which is why it is a separate field and not folded into `status`.
   */
  externalActivityFor(conversationId: string, now = Date.now()): SessionActivity | undefined {
    for (const entry of this.externalTails.values()) {
      if (entry.conversationId !== conversationId) continue;
      return {
        state:
          now - entry.lastActivityAt <= EXTERNAL_ACTIVE_WRITING_MS ? "active_writing" : "quiet",
        lastEventAt: new Date(entry.lastActivityAt).toISOString(),
        source: "jsonl",
      };
    }
    return undefined;
  }

  /** Attach inferred `activity` to externally-owned sessions in a response set. */
  withExternalActivity(sessions: readonly SessionResponse[]): readonly SessionResponse[] {
    if (this.externalTails.size === 0) return sessions;
    const now = Date.now();
    return sessions.map((s) => {
      if (s.ownership !== "external") return s;
      const activity = this.externalActivityFor(s.conversationId ?? s.id, now);
      return activity ? { ...s, activity } : s;
    });
  }

  /** Detach external tails idle past EXTERNAL_TAIL_IDLE_MS. */
  sweepIdleExternalTails(now = Date.now()): void {
    for (const [key, entry] of [...this.externalTails]) {
      if (this.isManagedTailPath(key)) {
        // Adopted by a PTY session — release bookkeeping, keep the watcher.
        this.externalTails.delete(key);
        continue;
      }
      if (now - entry.lastActivityAt > EXTERNAL_TAIL_IDLE_MS) this.detachExternalTail(key);
    }
  }

  /**
   * Push appended lines from an externally-owned conversation. Reuses the exact
   * conversation_events / conversation_event shapes mobile already consumes,
   * keyed by the conversation UUID — an external session has no PTY, so it must
   * never produce terminal_output / terminal_replay / session_ready, and never a
   * session_update whose session.id is a conversation UUID (that would mint a
   * phantom session row in the mobile cache). Question cards are likewise never
   * derived here: with no PTY there is nothing that could deliver an answer.
   */
  broadcastExternalTailLines(
    filePath: string,
    lines: string[],
    seqs?: (number | null)[] | null,
  ): void {
    const key = canonicalizeFilePath(filePath);
    const entry = this.externalTails.get(key);
    if (!entry) return;
    entry.lastActivityAt = Date.now();

    // Resolve the id from the cache row updateFromLines just wrote. Absent means
    // nothing recordable landed (or the batch was an agent JSONL, whose row is
    // deleted) — either way there is nothing to push.
    const conversationId = this.deps.cache()?.getIdByFilePath(key);
    if (!conversationId) return;
    entry.conversationId = conversationId;

    this.deps.broadcastConversationLines(conversationId, lines, seqs);

    // List-row refresh hint so clients don't have to poll ?refresh=1 to notice
    // an external conversation advancing.
    const meta = this.deps.cache()?.getMetaById(conversationId);
    this.deps.wsHub.broadcast({
      type: "conversation_updated",
      conversationId,
      messageCount: meta?.messageCount ?? 0,
      lastActivity: meta?.lastActivity ?? new Date().toISOString(),
      ownership: "external",
    });
  }
}
