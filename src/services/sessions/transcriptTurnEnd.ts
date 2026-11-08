import type { ProviderName } from "../../providers";

/**
 * When the transcript says a turn ended, as epoch ms, or null if this batch of
 * raw transcript lines holds no end-of-turn line (the latest one wins).
 *
 * Codex: an `event_msg` whose payload is `task_complete` or `turn_aborted`. A
 * subagent writes its own (`turn_id` differs from `root_turn_id`) while the
 * parent turn is still running, so only the root's counts.
 * Claude Code: a `system` line with subtype `turn_duration`, unless it is a
 * sidechain (subagent) turn.
 */
export function transcriptTurnEndAt(provider: ProviderName, lines: string[]): number | null {
  let latest: number | null = null;
  for (const line of lines) {
    // Cheap pre-filter: most lines are not turn ends and are large.
    if (!line.includes("turn_")) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o?.payload;
    const ends =
      provider === "codex-cli"
        ? o?.type === "event_msg" &&
          (p?.type === "task_complete" || p?.type === "turn_aborted") &&
          (p.root_turn_id == null || p.root_turn_id === p.turn_id)
        : provider === "claude-code" &&
          o?.type === "system" &&
          o.subtype === "turn_duration" &&
          o.isSidechain !== true;
    const ms = ends ? Date.parse(o.timestamp) : Number.NaN;
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

const CLAUDE_INTERRUPT = "[Request interrupted by user";

/**
 * Whether these Claude transcript lines hold the interrupt marker for
 * `promptId`: on Esc, Claude Code (verified on 2.1.319) writes a `user` line
 * whose text starts `[Request interrupted by user`, carrying the interrupted
 * turn's `promptId`, and no `turn_duration` follows.
 */
export function claudeTurnInterrupted(lines: string[], promptId: string): boolean {
  return lines.some((line) => {
    if (!line.includes(CLAUDE_INTERRUPT)) return false;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return false;
    }
    const text = o?.message?.content?.[0]?.text;
    return (
      o?.type === "user" &&
      o.promptId === promptId &&
      typeof text === "string" &&
      text.startsWith(CLAUDE_INTERRUPT)
    );
  });
}
