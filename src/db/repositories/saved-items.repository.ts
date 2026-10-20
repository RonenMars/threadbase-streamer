import type Database from "better-sqlite3";
import {
  SAVED_ITEMS_MAX,
  type SavedItemInput,
  savedItemKey,
} from "../../schemas/saved-items.schema";

/**
 * Saved (favorite) sessions and conversations, in runtime.db.
 * See tb-mobile docs/followups/mobile/10-floating-chat-shelf.md, PR B.
 *
 * One list per streamer, shared by every paired device.
 */

interface SavedItemRow {
  item_key: string;
  kind: SavedItemInput["kind"];
  label: string;
  session_id: string | null;
  conversation_id: string | null;
  chat_type: "session" | "conversation" | null;
  chat_id: string | null;
  project_id: string | null;
  position: number;
  updated_at: number;
}

export type SavedItemView = SavedItemInput & { key: string; position: number; updatedAt: number };

export interface SavedItemsList {
  items: SavedItemView[];
  revision: number;
}

export class SavedItemsFullError extends Error {
  constructor() {
    super(`At most ${SAVED_ITEMS_MAX} saved items`);
  }
}

function toView(row: SavedItemRow): SavedItemView {
  const common = {
    key: row.item_key,
    label: row.label,
    position: row.position,
    updatedAt: row.updated_at,
  };
  const projectId = row.project_id ?? undefined;
  switch (row.kind) {
    case "session":
      return {
        ...common,
        kind: "session",
        sessionId: row.session_id ?? "",
        ...(projectId ? { projectId } : {}),
      };
    case "conversation":
      return {
        ...common,
        kind: "conversation",
        conversationId: row.conversation_id ?? "",
        ...(projectId ? { projectId } : {}),
      };
    case "project-chat":
      return {
        ...common,
        kind: "project-chat",
        chatType: row.chat_type ?? "session",
        chatId: row.chat_id ?? "",
        projectId: projectId ?? "",
      };
  }
}

export class SavedItemsRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      list: db.prepare("SELECT * FROM saved_items ORDER BY position, item_key"),
      get: db.prepare("SELECT * FROM saved_items WHERE item_key = ?"),
      count: db.prepare("SELECT COUNT(*) AS n FROM saved_items"),
      nextPosition: db.prepare("SELECT COALESCE(MAX(position) + 1, 0) AS p FROM saved_items"),
      upsert: db.prepare(`
        INSERT INTO saved_items (item_key, kind, label, session_id, conversation_id, chat_type, chat_id,
                                 project_id, position, updated_at, updated_by_device)
        VALUES (@key, @kind, @label, @sessionId, @conversationId, @chatType, @chatId,
                @projectId, @position, @now, @deviceId)
        ON CONFLICT (item_key) DO UPDATE SET
          label = excluded.label,
          project_id = excluded.project_id,
          updated_at = excluded.updated_at,
          updated_by_device = excluded.updated_by_device`),
      remove: db.prepare("DELETE FROM saved_items WHERE item_key = ?"),
      setPosition: db.prepare("UPDATE saved_items SET position = ? WHERE item_key = ?"),
      revision: db.prepare("SELECT revision FROM saved_items_meta WHERE id = 1"),
      bump: db.prepare("UPDATE saved_items_meta SET revision = revision + 1 WHERE id = 1"),
    };
  }

  list(): SavedItemsList {
    const rows = this.stmts.list.all() as SavedItemRow[];
    return { items: rows.map(toView), revision: this.revision() };
  }

  revision(): number {
    return (this.stmts.revision.get() as { revision: number } | undefined)?.revision ?? 0;
  }

  /** Insert, or update the label and project of an existing key in place. */
  upsert(item: SavedItemInput, deviceId?: string): SavedItemView {
    const key = savedItemKey(item);
    return this.db.transaction(() => {
      const existing = this.stmts.get.get(key) as SavedItemRow | undefined;
      if (!existing && (this.stmts.count.get() as { n: number }).n >= SAVED_ITEMS_MAX) {
        throw new SavedItemsFullError();
      }
      const position = existing?.position ?? (this.stmts.nextPosition.get() as { p: number }).p;
      this.stmts.upsert.run({
        key,
        kind: item.kind,
        label: item.label,
        sessionId: item.kind === "session" ? item.sessionId : null,
        conversationId: item.kind === "conversation" ? item.conversationId : null,
        chatType: item.kind === "project-chat" ? item.chatType : null,
        chatId: item.kind === "project-chat" ? item.chatId : null,
        projectId: item.projectId ?? null,
        position,
        now: Date.now(),
        deviceId: deviceId ?? null,
      });
      this.stmts.bump.run();
      return toView(this.stmts.get.get(key) as SavedItemRow);
    })();
  }

  /** Idempotent: removing an unknown key is not an error. */
  remove(key: string): boolean {
    return this.db.transaction(() => {
      const removed = this.stmts.remove.run(key).changes > 0;
      if (removed) this.stmts.bump.run();
      return removed;
    })();
  }

  /**
   * Listed keys take the first positions, in order. Unknown keys are ignored,
   * and stored keys the caller left out keep their relative order after them,
   * so a phone holding a stale list can reorder but never drop an item.
   */
  reorder(keys: string[]): SavedItemsList {
    this.db.transaction(() => {
      const current = (this.stmts.list.all() as SavedItemRow[]).map((r) => r.item_key);
      const known = new Set(current);
      const leading = new Set(keys.filter((k) => known.has(k)));
      const next = [...leading, ...current.filter((k) => !leading.has(k))];
      for (const [position, key] of next.entries()) this.stmts.setPosition.run(position, key);
      this.stmts.bump.run();
    })();
    return this.list();
  }
}
