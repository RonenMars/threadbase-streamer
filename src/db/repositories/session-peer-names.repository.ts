import type Database from "better-sqlite3";
import type { DiscoveredProcess } from "../../types";
import type { RuntimeStore } from "../runtime-store";

export interface PeerNameView {
  name: string;
  source: string | null;
  since: number | null;
  pid: number;
  /** When this row last changed, not when it was last seen. */
  updatedAt: number;
}

interface PeerNameRow {
  peer_name: string;
  peer_name_source: string | null;
  name_since: number | null;
  pid: number;
  updated_at: number;
}

export class SessionPeerNamesRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      get: db.prepare("SELECT * FROM session_peer_names WHERE conversation_id = ?"),
      // Writes only when something changed, so a sweep every 15 s costs no I/O.
      upsert: db.prepare(`
        INSERT INTO session_peer_names
          (conversation_id, peer_name, peer_name_source, name_since, pid, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          peer_name = excluded.peer_name,
          peer_name_source = excluded.peer_name_source,
          name_since = excluded.name_since,
          pid = excluded.pid,
          updated_at = excluded.updated_at
        WHERE peer_name IS NOT excluded.peer_name
           OR peer_name_source IS NOT excluded.peer_name_source
           OR name_since IS NOT excluded.name_since
           OR pid IS NOT excluded.pid
      `),
    };
  }

  /** Record each process's peer name. Rows are never deleted: the last name outlives the process. */
  record(processes: readonly DiscoveredProcess[], now: number = Date.now()): void {
    this.db.transaction(() => {
      for (const p of processes) {
        if (!p.conversationId || !p.peerName) continue;
        this.stmts.upsert.run(
          p.conversationId,
          p.peerName.name,
          p.peerName.source ?? null,
          p.peerName.since ?? null,
          p.pid,
          now,
        );
      }
    })();
  }

  get(conversationId: string): PeerNameView | null {
    const r = this.stmts.get.get(conversationId) as PeerNameRow | undefined;
    if (!r) return null;
    return {
      name: r.peer_name,
      source: r.peer_name_source,
      since: r.name_since,
      pid: r.pid,
      updatedAt: r.updated_at,
    };
  }
}

const repos = new WeakMap<Database.Database, SessionPeerNamesRepository>();

export function sessionPeerNamesFor(store: RuntimeStore | null): SessionPeerNamesRepository | null {
  const db = store?.getDatabase();
  if (!db) return null;
  let repo = repos.get(db);
  if (!repo) {
    repo = new SessionPeerNamesRepository(db);
    repos.set(db, repo);
  }
  return repo;
}
