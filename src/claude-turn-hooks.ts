// Claude turn boundaries from Claude's own hooks (#535, flag `claudeTurnHooks`).
//
// Each spawned session gets UserPromptSubmit / Stop / StopFailure command hooks
// that append their stdin payload (one JSON line, carrying `prompt_id`) to a
// per-session file the streamer tails. Verified on Claude Code 2.1.319 in a
// PTY: a completed turn fires UserPromptSubmit then Stop, a failed one
// UserPromptSubmit then StopFailure, and an Esc interrupt fires no Stop at all,
// so the screen/transcript signals stay the backstop for interrupts.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  unwatchFile,
  watchFile,
} from "fs";

const HOOK_POLL_MS = 150;

export interface ClaudeHookPayload {
  hook_event_name?: unknown;
  prompt_id?: unknown;
  error?: unknown;
}

// The hook must print nothing (a UserPromptSubmit hook's stdout is added to
// Claude's context) and always exit 0 (a failing hook surfaces in the TUI every
// turn), even once the streamer that owned the file is gone.
function hookCommand(file: string): string {
  return `{ cat; printf '\\n'; } 2>/dev/null >> '${file.replace(/'/g, `'\\''`)}'; exit 0`;
}

export function turnHooksSettings(file: string): Record<string, unknown> {
  const entry = () => [{ hooks: [{ type: "command", command: hookCommand(file) }] }];
  return { UserPromptSubmit: entry(), Stop: entry(), StopFailure: entry() };
}

/**
 * Tail `file` from its start, handing each read's complete lines to `onBatch`
 * in write order. Returns the stop function.
 */
export function tailHookFile(
  file: string,
  onBatch: (payloads: ClaudeHookPayload[]) => void,
): () => void {
  appendFileSync(file, "", { mode: 0o600 }); // create without truncating an early write
  let offset = 0;
  let partial = "";
  const drain = () => {
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      return; // removed on session end
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return; // nothing new; also guards an outside truncate
      const buf = Buffer.alloc(size - offset);
      offset += readSync(fd, buf, 0, buf.length, offset);
      const lines = (partial + buf.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      const payloads: ClaudeHookPayload[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          payloads.push(JSON.parse(line));
        } catch {
          // not a hook payload; skip it
        }
      }
      if (payloads.length) onBatch(payloads);
    } finally {
      closeSync(fd);
    }
  };
  // Stat polling, not fs.watch: macOS FSEvents misses a write landing just
  // after the watch starts. ponytail: one stat per session per interval.
  watchFile(file, { interval: HOOK_POLL_MS, persistent: false }, drain);
  return () => unwatchFile(file, drain);
}
