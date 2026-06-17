import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { extname, join } from "path";

const UPLOAD_DIR_NAME = ".threadbase-uploads";
const MAX_BYTES = 25 * 1024 * 1024; // 25MB

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/plain": ".txt",
  "text/javascript": ".js",
  "application/typescript": ".ts",
  "application/json": ".json",
  "text/csv": ".csv",
};

export interface SaveUploadInput {
  sessionId: string;
  projectPath: string;
  originalName: string;
  mimeType: string;
  dataBase64: string;
}

export interface SavedUpload {
  id: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export async function saveUploadFile(input: SaveUploadInput): Promise<SavedUpload> {
  const buffer = Buffer.from(input.dataBase64, "base64");
  if (buffer.length === 0) throw new Error("Empty file");
  if (buffer.length > MAX_BYTES) throw new Error(`File exceeds ${MAX_BYTES} bytes`);

  const id = `up_${randomBytes(8).toString("hex")}`;
  const safeName =
    sanitizeFilename(input.originalName) || `file${MIME_TO_EXT[input.mimeType] ?? ""}`;
  const dir = join(input.projectPath, UPLOAD_DIR_NAME, input.sessionId);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, `${Date.now()}-${id}-${safeName}`);
  await writeFile(filePath, buffer);

  return {
    id,
    filePath,
    originalName: safeName,
    mimeType: input.mimeType,
    sizeBytes: buffer.length,
  };
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (!cleaned) return "";
  // Preserve extension only if it looks safe
  const ext = extname(cleaned).toLowerCase();
  return ext ? cleaned : cleaned;
}
