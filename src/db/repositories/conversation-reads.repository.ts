import type Database from "better-sqlite3";

/**
 * Read acks for the unread dot, in runtime.db, shared by every paired device.
 * See docs/plans/unread-messages-plan.md §2 and §4.2.
 *
 * Two files, no ATTACH: the caller reads countable messages from the cache and
 * hands them in; this class only knows acks and the frontier.
 */

export interface AckedMessage {
  key: string;
  /** Transcript timestamp, epoch ms. */
  ts: number;
}

export interface NewAck {
  key: string;
  readAt: number;
}

/** The key a message is acked under: its uuid, else its timestamp. */
export const messageKey = (uuid: string | null | undefined, ts: number): string =>
  uuid || `ts:${ts}`;

export class ConversationReadsRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      baseline: db.prepare("SELECT baseline FROM conversation_reads_meta WHERE id = 1"),
      frontier: db.prepare("SELECT frontier FROM conversation_reads WHERE conversation_id = ?"),
      setFrontier: db.prepare(
        `INSERT INTO conversation_reads (conversation_id, frontier, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET
           frontier = excluded.frontier, updated_at = excluded.updated_at
         WHERE excluded.frontier > conversation_reads.frontier`,
      ),
      ack: db.prepare(
        `INSERT OR IGNORE INTO message_reads
           (conversation_id, message_key, message_ts, read_at, read_by_device)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      isAcked: db.prepare(
        "SELECT 1 FROM message_reads WHERE conversation_id = ? AND message_key = ?",
      ),
      readAt: db.prepare(
        "SELECT read_at FROM message_reads WHERE conversation_id = ? AND message_key = ?",
      ),
    };
  }

  baseline(): number {
    return (this.stmts.baseline.get() as { baseline: number } | undefined)?.baseline ?? 0;
  }

  /** The read point of each id; an id with no row is read through the baseline. */
  frontiers(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    const base = this.baseline();
    // SQLite's default variable limit is 32766; a list page is far below it.
    const rows = ids.length
      ? (this.db
          .prepare(
            `SELECT conversation_id, frontier FROM conversation_reads
             WHERE conversation_id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as { conversation_id: string; frontier: number }[])
      : [];
    for (const r of rows) out.set(r.conversation_id, r.frontier);
    for (const id of ids) if (!out.has(id)) out.set(id, base);
    return out;
  }

  frontier(id: string): number {
    return (
      (this.stmts.frontier.get(id) as { frontier: number } | undefined)?.frontier ?? this.baseline()
    );
  }

  /** Record acks; the first one for a message wins. Returns only the new ones. */
  recordAcks(id: string, messages: AckedMessage[], deviceId: string | null): NewAck[] {
    const now = Date.now();
    return this.db.transaction(() => {
      const fresh: NewAck[] = [];
      for (const m of messages) {
        if (this.stmts.ack.run(id, m.key, m.ts, now, deviceId).changes > 0) {
          fresh.push({ key: m.key, readAt: now });
        }
      }
      return fresh;
    })();
  }

  /**
   * Move the frontier over the unbroken acked prefix of `countableAbove`
   * (the conversation's countable messages above the current frontier, oldest
   * first) and return it. It never moves backward, and never steps over a
   * timestamp that still has an unacked message. Messages that share a
   * timestamp are all-or-nothing.
   */
  advance(id: string, countableAbove: AckedMessage[]): number {
    let target: number | null = null;
    for (let i = 0; i < countableAbove.length; i++) {
      const m = countableAbove[i];
      if (!this.stmts.isAcked.get(id, m.key)) break;
      if (countableAbove[i + 1]?.ts !== m.ts) target = m.ts;
    }
    if (target !== null) this.stmts.setFrontier.run(id, target, Date.now());
    return this.frontier(id);
  }

  /** `key → read_at` (epoch ms) for the acked keys among `keys`. */
  acksFor(id: string, keys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const key of keys) {
      const row = this.stmts.readAt.get(id, key) as { read_at: number } | undefined;
      if (row) out.set(key, row.read_at);
    }
    return out;
  }
}
