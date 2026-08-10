import { statSync, truncateSync } from "node:fs";
import { logPaths } from "./constants";

/**
 * Size above which a supervised log file is emptied at boot. Nothing else
 * bounds these files: the plist/unit/task points StandardOutPath straight at
 * them, there is no logrotate or newsyslog entry, and none is wanted — see
 * `truncateOversizedLogs` for why rotation-by-rename cannot work here.
 */
export const LOG_CAP_BYTES = 32 * 1024 * 1024;

/**
 * Empty every supervised log file larger than `maxBytes`, returning the paths
 * actually truncated.
 *
 * **Truncate, never rename or unlink.** The supervisor holds the descriptor via
 * StandardOutPath/StandardError, so replacing the inode leaves the daemon
 * writing to an unlinked file that nobody can read and the visible one frozen
 * at zero. `truncate(2)` keeps the inode, which is why it is the only move
 * available.
 *
 * **Boot is the only safe moment.** `truncate(2)` resets the inode size but not
 * any open writer's seek offset, so emptying a live daemon's log leaves its next
 * write landing at the old offset with the kernel filling 0..N with NULs (the
 * sparse-log bug in docs/BACKLOG.md). Here the calling process has written
 * nothing yet, so its own fd is still at offset 0 and no gap can form. The one
 * window that remains is a previous process still dying with a high offset on
 * its own descriptor; `kickstart -k` kills it first, so the overlap is brief and
 * only reachable on the rare boot that finds the file already over the cap.
 *
 * Best-effort by design: a log that cannot be stat'd or truncated — missing,
 * unreadable, locked on Windows — must never stop the server from booting.
 *
 * ponytail: bounds growth across restarts only; an instance that runs for months
 * without one still grows unbounded. Upgrade path is a periodic size check on
 * the same truncate-in-place call, or a pino transport owning its own file —
 * note the latter leaves real stdout (uncaught stacks, node warnings, PTY noise)
 * still unrotated, so it does not replace this on its own.
 */
export function truncateOversizedLogs(
  maxBytes: number = LOG_CAP_BYTES,
  paths: string[] = Object.values(logPaths()),
): string[] {
  const truncated: string[] = [];
  for (const file of paths) {
    try {
      if (statSync(file).size <= maxBytes) continue;
      truncateSync(file, 0);
      truncated.push(file);
    } catch {
      // Never fatal at boot.
    }
  }
  return truncated;
}
