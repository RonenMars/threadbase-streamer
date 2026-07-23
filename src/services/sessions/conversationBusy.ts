import { statSync } from "fs";
import type { DiscoveredProcess } from "../../types";
import { canonicalizeProjectPath } from "../../utils/canonicalizeProjectPath";

// A conversation's JSONL touched within this window is treated as actively
// owned. This is the PRIMARY collision signal — it is the only one that catches
// a session launched WITHOUT `--resume` (no process argv to match). Exported so
// callers and tests share one value; override at runtime via the env var below.
export const RESUME_BUSY_WINDOW_MS = 120_000;

// Resolve the busy window, allowing an env override (ms). Falls back to the
// constant for missing/invalid values.
export function resolveResumeBusyWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.THREADBASE_RESUME_BUSY_WINDOW_MS;
  if (raw === undefined) return RESUME_BUSY_WINDOW_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : RESUME_BUSY_WINDOW_MS;
}

export type BusySignal = "jsonl_mtime" | "process_argv" | "process_cwd";

// Allowance for a JSONL write that lands just AFTER we observe our own PTY go
// idle — Claude flushes the tail of a turn as it exits, so the file's mtime can
// trail the exit by a moment. Without this the flush would read as foreign.
const SELF_ACTIVITY_SKEW_MS = 5_000;

export interface ConversationBusyInput {
  conversationId: string;
  projectPath: string | null;
  jsonlPath: string | null;
  discovered: DiscoveredProcess[];
  now?: number;
  windowMs?: number;
  platform?: NodeJS.Platform;
  /**
   * When this streamer's own PTY for this conversation last went idle (ms epoch),
   * or null/undefined if it never owned one in this process's lifetime.
   *
   * Without this the probe cannot tell our own echo from a stranger: the normal
   * background → hold_session → foreground → resume flow releases the PTY (so the
   * hasSession early-return no longer applies) while leaving a JSONL we wrote
   * seconds ago — which would 409 the single most common resume in the product.
   * File activity at or before this timestamp is attributed to us, not a collision.
   */
  selfPtyEndedAt?: number | null;
}

export interface ConversationBusyResult {
  busy: boolean;
  detectedBy: BusySignal[];
  // Milliseconds since the JSONL was last written (now - mtime), or null when
  // there is no readable JSONL to measure.
  lastActivityMs: number | null;
  likelyOwner: "external" | "unknown";
}

// Pre-flight collision probe for a conversation about to be resumed. Pure with
// respect to process discovery (the caller passes `discovered`); only touches
// the filesystem to stat the JSONL. No `force` handling here — that is a caller
// decision (a forced resume never runs this).
export function conversationBusy(input: ConversationBusyInput): ConversationBusyResult {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? RESUME_BUSY_WINDOW_MS;
  const platform = input.platform ?? process.platform;
  const detectedBy: BusySignal[] = [];
  let lastActivityMs: number | null = null;

  // Signal 1 (PRIMARY): the JSONL was modified within the busy window. Only the
  // UPPER bound matters — a just-written file can carry an mtime a few ms in the
  // FUTURE (filesystem timestamp granularity / clock skew), which still means
  // "active right now". Over-detecting busy is the safe direction (soft 409 with
  // a force override); under-detecting would miss a real collision.
  if (input.jsonlPath) {
    try {
      const mtimeMs = statSync(input.jsonlPath).mtimeMs;
      const age = now - mtimeMs;
      lastActivityMs = Math.max(0, age);
      // Attribute the write: if the file has not been touched since our own PTY
      // for this conversation released it, the recency is our own echo (a
      // hold → resume round trip), not evidence of another owner.
      const isSelfEcho =
        input.selfPtyEndedAt != null && mtimeMs <= input.selfPtyEndedAt + SELF_ACTIVITY_SKEW_MS;
      if (age <= windowMs && !isSelfEcho) detectedBy.push("jsonl_mtime");
    } catch {
      // File missing / unreadable — no mtime signal.
    }
  }

  // Signal 2: a discovered process is resuming this exact conversation id.
  const argvMatch = input.discovered.some((p) => p.conversationId === input.conversationId);
  if (argvMatch) detectedBy.push("process_argv");

  // Signal 3: a discovered process is running in this conversation's project
  // directory. POSIX only — a process cwd is not available on win32.
  let cwdMatch = false;
  if (platform !== "win32" && input.projectPath) {
    const target = canonicalizeProjectPath(input.projectPath);
    cwdMatch = input.discovered.some(
      (p) => !!p.projectPath && canonicalizeProjectPath(p.projectPath) === target,
    );
    if (cwdMatch) detectedBy.push("process_cwd");
  }

  return {
    busy: detectedBy.length > 0,
    detectedBy,
    lastActivityMs,
    // A matched process is a concrete external owner; a lone mtime hit could be
    // an editor, a crashed process, or a process we could not enumerate.
    likelyOwner: argvMatch || cwdMatch ? "external" : "unknown",
  };
}
