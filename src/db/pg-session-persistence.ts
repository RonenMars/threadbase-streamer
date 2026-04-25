import type pg from "pg";
import type { ManagedSession } from "../types";
import type { SessionPersistence } from "./session-persistence";

export class PgSessionPersistence implements SessionPersistence {
  constructor(
    private pool: pg.Pool,
    private instanceId: string,
  ) {}

  async save(session: ManagedSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO managed_sessions (
        id, conversation_id, project_path, project_name, branch,
        status, started_at, completed_at, prompt_count, last_output,
        session_name, model, account, message_count, preview,
        first_message_text, first_message_at, last_message_text, last_message_at, file_path,
        instance_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        completed_at = EXCLUDED.completed_at,
        prompt_count = EXCLUDED.prompt_count,
        last_output = EXCLUDED.last_output,
        message_count = EXCLUDED.message_count,
        last_message_text = EXCLUDED.last_message_text,
        last_message_at = EXCLUDED.last_message_at,
        instance_id = EXCLUDED.instance_id,
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
        session.sessionName ?? null,
        session.model ?? null,
        session.account ?? null,
        session.messageCount ?? 0,
        session.preview ?? null,
        session.firstMessageText ?? null,
        session.firstMessageAt ?? null,
        session.lastMessageText ?? null,
        session.lastMessageAt ?? null,
        session.filePath ?? null,
        this.instanceId,
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
      sessionName: "session_name",
      model: "model",
      account: "account",
      messageCount: "message_count",
      preview: "preview",
      firstMessageText: "first_message_text",
      firstMessageAt: "first_message_at",
      lastMessageText: "last_message_text",
      lastMessageAt: "last_message_at",
      filePath: "file_path",
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
    values.push(this.instanceId);

    await this.pool.query(
      `UPDATE managed_sessions SET ${setClauses.join(", ")} WHERE id = $${paramIdx} AND (instance_id = $${paramIdx + 1} OR instance_id IS NULL)`,
      values,
    );
  }

  async remove(sessionId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM managed_sessions WHERE id = $1 AND (instance_id = $2 OR instance_id IS NULL)",
      [sessionId, this.instanceId],
    );
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
      session_name: string | null;
      model: string | null;
      account: string | null;
      message_count: number;
      preview: string | null;
      first_message_text: string | null;
      first_message_at: Date | null;
      last_message_text: string | null;
      last_message_at: Date | null;
      file_path: string | null;
    }>(
      "SELECT * FROM managed_sessions WHERE instance_id = $1 OR instance_id IS NULL ORDER BY started_at DESC",
      [this.instanceId],
    );

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
      ...(row.session_name != null && { sessionName: row.session_name }),
      ...(row.model != null && { model: row.model }),
      ...(row.account != null && { account: row.account }),
      ...(row.message_count && { messageCount: row.message_count }),
      ...(row.preview != null && { preview: row.preview }),
      ...(row.first_message_text != null && { firstMessageText: row.first_message_text }),
      ...(row.first_message_at != null && { firstMessageAt: row.first_message_at }),
      ...(row.last_message_text != null && { lastMessageText: row.last_message_text }),
      ...(row.last_message_at != null && { lastMessageAt: row.last_message_at }),
      ...(row.file_path != null && { filePath: row.file_path }),
    }));
  }
}
