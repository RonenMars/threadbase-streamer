import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { Project } from "../../schemas/project.schema";
import { canonicalizeProjectPath } from "../../utils/canonicalizeProjectPath";

interface ProjectRow {
  id: string;
  path: string;
  name: string | null;
  last_conversation_id: string | null;
  last_conversation_created_at: string | null;
  last_indexed_at: string | null;
  latest_message_at: string | null;
  latest_message_id: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    lastConversationId: row.last_conversation_id,
    lastConversationCreatedAt: row.last_conversation_created_at,
    lastIndexedAt: row.last_indexed_at,
    latestMessageAt: row.latest_message_at,
    latestMessageId: row.latest_message_id,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertProjectInput {
  lastConversationId?: string | null;
  lastConversationCreatedAt?: string | null;
  latestMessageAt?: string | null;
  latestMessageId?: string | null;
  name?: string | null;
}

export class ProjectsRepository {
  private getByPath: Database.Statement;
  private getById: Database.Statement;
  private listAll: Database.Statement;
  private insert: Database.Statement;
  private update: Database.Statement;

  constructor(private db: Database.Database) {
    this.getByPath = db.prepare("SELECT * FROM projects WHERE path = ?");
    this.getById = db.prepare("SELECT * FROM projects WHERE id = ?");
    this.listAll = db.prepare("SELECT * FROM projects ORDER BY updated_at DESC");
    this.insert = db.prepare(`
      INSERT INTO projects (
        id, path, name,
        last_conversation_id, last_conversation_created_at, last_indexed_at,
        latest_message_at, latest_message_id, message_count,
        created_at, updated_at
      ) VALUES (
        @id, @path, @name,
        @last_conversation_id, @last_conversation_created_at, @last_indexed_at,
        @latest_message_at, @latest_message_id, @message_count,
        @created_at, @updated_at
      )
    `);
    this.update = db.prepare(`
      UPDATE projects SET
        name                         = COALESCE(@name, name),
        last_conversation_id         = COALESCE(@last_conversation_id, last_conversation_id),
        last_conversation_created_at = COALESCE(@last_conversation_created_at, last_conversation_created_at),
        last_indexed_at              = COALESCE(@last_indexed_at, last_indexed_at),
        latest_message_at            = COALESCE(@latest_message_at, latest_message_at),
        latest_message_id            = COALESCE(@latest_message_id, latest_message_id),
        updated_at                   = @updated_at
      WHERE id = @id
    `);
  }

  getProjectByPath(rawPath: string): Project | null {
    const path = canonicalizeProjectPath(rawPath);
    const row = this.getByPath.get(path) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  getProjectById(id: string): Project | null {
    const row = this.getById.get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  listProjects(): Project[] {
    return (this.listAll.all() as ProjectRow[]).map(rowToProject);
  }

  /**
   * Insert a project at the given canonical path, or update its metadata
   * if one already exists. Returns the persisted Project row.
   *
   * Idempotent: passing the same path twice returns the same project id.
   */
  upsertProjectByPath(rawPath: string, input: UpsertProjectInput = {}): Project {
    const path = canonicalizeProjectPath(rawPath);
    const now = new Date().toISOString();

    const existing = this.getByPath.get(path) as ProjectRow | undefined;
    if (existing) {
      this.update.run({
        id: existing.id,
        name: input.name ?? null,
        last_conversation_id: input.lastConversationId ?? null,
        last_conversation_created_at: input.lastConversationCreatedAt ?? null,
        last_indexed_at: now,
        latest_message_at: input.latestMessageAt ?? null,
        latest_message_id: input.latestMessageId ?? null,
        updated_at: now,
      });
      return rowToProject(this.getById.get(existing.id) as ProjectRow);
    }

    const id = randomUUID();
    this.insert.run({
      id,
      path,
      name: input.name ?? deriveNameFromPath(path),
      last_conversation_id: input.lastConversationId ?? null,
      last_conversation_created_at: input.lastConversationCreatedAt ?? null,
      last_indexed_at: now,
      latest_message_at: input.latestMessageAt ?? null,
      latest_message_id: input.latestMessageId ?? null,
      message_count: 0,
      created_at: now,
      updated_at: now,
    });
    return rowToProject(this.getById.get(id) as ProjectRow);
  }
}

function deriveNameFromPath(path: string): string | null {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}
