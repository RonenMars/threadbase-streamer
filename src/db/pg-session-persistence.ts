import type pg from "pg";
import type { ManagedSession } from "../types";
import type { SessionPersistence } from "./session-persistence";

export class PgSessionPersistence implements SessionPersistence {
  constructor(private pool: pg.Pool) {}

  async save(session: ManagedSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO managed_sessions (
        id, conversation_id, project_path, project_name, branch,
        status, started_at, completed_at, prompt_count, last_output
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        completed_at = EXCLUDED.completed_at,
        prompt_count = EXCLUDED.prompt_count,
        last_output = EXCLUDED.last_output,
        updated_at = NOW()`,
      [
        session.id,
        session.conversationId,
        session.projectPath,
        session.projectName,
        session.branch,
        session.status,
        session.startedAt,
        session.completedAt,
        session.promptCount,
        session.lastOutput,
      ],
    );
  }

  async update(sessionId: string, updates: Partial<ManagedSession>): Promise<void> {
    const fieldMap: Record<string, string> = {
      conversationId: "conversation_id",
      projectPath: "project_path",
      projectName: "project_name",
      branch: "branch",
      status: "status",
      startedAt: "started_at",
      completedAt: "completed_at",
      promptCount: "prompt_count",
      lastOutput: "last_output",
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const [tsKey, dbCol] of Object.entries(fieldMap)) {
      if (tsKey in updates) {
        setClauses.push(`${dbCol} = $${paramIdx}`);
        values.push((updates as any)[tsKey]);
        paramIdx++;
      }
    }

    if (setClauses.length === 0) return;

    setClauses.push(`updated_at = NOW()`);
    values.push(sessionId);

    await this.pool.query(
      `UPDATE managed_sessions SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values,
    );
  }

  async remove(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM managed_sessions WHERE id = $1", [sessionId]);
  }

  async loadAll(): Promise<ManagedSession[]> {
    const { rows } = await this.pool.query<{
      id: string;
      conversation_id: string;
      project_path: string;
      project_name: string;
      branch: string;
      status: string;
      started_at: Date;
      completed_at: Date | null;
      prompt_count: number;
      last_output: string;
    }>("SELECT * FROM managed_sessions ORDER BY started_at DESC");

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      projectPath: row.project_path,
      projectName: row.project_name,
      branch: row.branch,
      status: row.status as ManagedSession["status"],
      startedAt: row.started_at,
      completedAt: row.completed_at,
      promptCount: row.prompt_count,
      lastOutput: row.last_output,
    }));
  }
}
