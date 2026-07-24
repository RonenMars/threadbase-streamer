import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import heicConvert from "heic-convert";
import { join } from "path";

const UPLOAD_DIR_NAME = ".threadbase-uploads";
const MAX_BYTES = 25 * 1024 * 1024; // 25MB

const HEIC_MIMES = new Set(["image/heic", "image/heif"]);

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".jpg",
  "image/heif": ".jpg",
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
  let buffer = Buffer.from(input.dataBase64, "base64");
  if (buffer.length === 0) throw new Error("Empty file");
  if (buffer.length > MAX_BYTES) throw new Error(`File exceeds ${MAX_BYTES} bytes`);

  let { mimeType } = input;
  let originalName = input.originalName;

  if (HEIC_MIMES.has(mimeType)) {
    buffer = Buffer.from(await heicConvert({ buffer, format: "JPEG", quality: 0.85 }));
    mimeType = "image/jpeg";
    originalName = originalName.replace(/\.(heic|heif)$/i, ".jpg");
  }

  const id = `up_${randomBytes(8).toString("hex")}`;
  const safeName = sanitizeFilename(originalName) || `file${MIME_TO_EXT[mimeType] ?? ""}`;
  const dir = join(input.projectPath, UPLOAD_DIR_NAME, input.sessionId);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, `${Date.now()}-${id}-${safeName}`);
  await writeFile(filePath, buffer);

  return {
    id,
    filePath,
    originalName: safeName,
    mimeType,
    sizeBytes: buffer.length,
  };
}

function sanitizeFilename(name: string): string {
  // Take only the basename (block path traversal)
  const base = name.split(/[\\/]/).pop() ?? "";
  // Strip leading dots; keep all printable Unicode (charCode >= 32, != 127)
  const cleaned = base
    .replace(/^\.+/, "")
    .split("")
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    // Replace spaces and other shell-problematic characters with underscores.
    // Mobile sends paths as @path references; Claude Code's parser splits on
    // whitespace, so "My Photo.jpg" becomes "@/path/My" + "Photo.jpg" (broken).
    .replace(/[\s@"'`$\\]/g, "_");
  return cleaned;
}
