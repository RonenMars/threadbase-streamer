import { parseIsoDateOrNull } from "./dates";

// The on-disk mtime can run slightly ahead of the last message's own timestamp
// (filesystem flush latency, non-message trailer lines like pr-link/mode that
// the scanner ignores for `timestamp` but still bump mtime). Require the file
// to be at least this much newer than the snapshot before forcing a re-scan, so
// a single read doesn't churn the whole scanner index on every detail fetch.
const STALENESS_TOLERANCE_MS = 1000;

/**
 * Decide whether a scanned conversation snapshot is stale relative to the
 * JSONL on disk. The scanner memoizes both its metadata index and parsed
 * conversations for the server's lifetime, so a conversation that grows after
 * the initial scan keeps serving the startup snapshot from
 * `/api/conversations/{id}`. We compare the file's mtime against the
 * snapshot's last-activity timestamp to detect that drift.
 *
 * Returns true when the file is meaningfully newer than the snapshot (a
 * re-scan is warranted). Returns false when the snapshot is current, when the
 * snapshot timestamp is unparseable (nothing to compare against — leave it),
 * or when mtime is null (stat failed — don't churn the index on a transient
 * read error).
 */
export function isScannedSnapshotStale(
  snapshotTimestamp: string | null | undefined,
  fileMtimeMs: number | null,
): boolean {
  if (fileMtimeMs == null) return false;
  const snapshotDate = parseIsoDateOrNull(snapshotTimestamp);
  if (!snapshotDate) return false;
  return fileMtimeMs - snapshotDate.getTime() > STALENESS_TOLERANCE_MS;
}
