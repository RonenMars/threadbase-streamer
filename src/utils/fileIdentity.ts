import { createHash } from "crypto";
import type { Stats } from "fs";

/**
 * Stable identity for a JSONL file, used to detect replacement (a new file at
 * the same path) vs. mere growth. Prefer the inode (dev:ino) — cheap and exact.
 * When the inode is unavailable (ino === 0, e.g. some network/virtual FS), fall
 * back to a fingerprint of the first bytes supplied by the caller.
 */
export function fileIdentity(stat: Pick<Stats, "dev" | "ino">, headBytes?: Buffer): string {
  if (stat.ino && stat.ino > 0) return `inode:${stat.dev}:${stat.ino}`;
  const head = headBytes ?? Buffer.alloc(0);
  return `fp:${createHash("sha1").update(head).digest("hex")}`;
}

export interface LineSpan {
  /** Absolute byte offset of the line's first byte in the file. */
  byteOffset: number;
  /** Byte length of the line content, excluding the trailing "\n". */
  byteLength: number;
  /** The decoded line text (no trailing "\n"). */
  text: string;
}

export interface SplitResult {
  spans: LineSpan[];
  /**
   * Bytes consumed = up to and including the last "\n" in `buf`. A trailing
   * partial line (no newline yet) is NOT consumed, so the caller's byte offset
   * never advances past an incomplete line. Those bytes arrive again, whole, on
   * the next read.
   */
  consumed: number;
}

/**
 * Split a buffer of appended bytes into complete-line spans with absolute byte
 * offsets. `baseOffset` is the file position of `buf`'s first byte.
 *
 * Only lines terminated by "\n" produce a span; the remainder after the final
 * newline is left for the next read (torn-write safety, design §7.5 #4). Empty
 * lines (a bare "\n") produce no span but are still consumed.
 */
export function splitCompleteLines(buf: Buffer, baseOffset: number): SplitResult {
  const spans: LineSpan[] = [];
  let lineStart = 0; // index within buf where the current line begins
  let consumed = 0;

  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue; // "\n"
    const lineLen = i - lineStart; // excludes the newline
    if (lineLen > 0) {
      spans.push({
        byteOffset: baseOffset + lineStart,
        byteLength: lineLen,
        text: buf.toString("utf-8", lineStart, i),
      });
    }
    lineStart = i + 1;
    consumed = lineStart; // up to and including this "\n"
  }

  return { spans, consumed };
}
