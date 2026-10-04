import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import heicConvert from "heic-convert";
import { join } from "path";
import { HEADER_BYTES, MAX_UPLOAD_RECORD_BYTES, TAG_BYTES } from "./e2ee/record";

const UPLOAD_DIR_NAME = ".threadbase-uploads";
/** Keys, filename and mime type around the base64 in the upload JSON. */
const JSON_WRAPPER_HEADROOM_BYTES = 8 * 1024;

/**
 * The largest file the sealed upload route can carry. Derived from the sealed-request
 * cap rather than repeated, so the two cannot drift: the body is the file as base64
 * (4 bytes per 3) inside a small JSON wrapper, and `ENVELOPE_HEADROOM_BYTES` is
 * what is left for the record header and tag and the JSON wrapper.
 */
const ENVELOPE_HEADROOM_BYTES = HEADER_BYTES + TAG_BYTES + JSON_WRAPPER_HEADROOM_BYTES;
export const MAX_BYTES = Math.floor(((MAX_UPLOAD_RECORD_BYTES - ENVELOPE_HEADROOM_BYTES) * 3) / 4);

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
