import type pg from "pg";

export interface UploadRecord {
  id: string;
  sessionId: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export async function recordUpload(
  pool: pg.Pool | null,
  instanceId: string | null,
  row: UploadRecord,
): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO session_uploads
       (id, session_id, instance_id, file_path, original_name, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.id,
      row.sessionId,
      instanceId,
      row.filePath,
      row.originalName,
      row.mimeType,
      row.sizeBytes,
    ],
  );
}
