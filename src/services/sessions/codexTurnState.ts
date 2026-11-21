import { open, stat } from "fs/promises";
import {
  CODEX_PROMPT_READY_TEXT,
  CODEX_WORKING_STATUS_RE,
  codexStatusBarWords,
  detectCodexBlockingPrompt,
  detectCodexCommandApproval,
  detectCodexPicker,
} from "../questions/codexScreen";

/**
 * What an external Codex process's rollout says about its root turn. Inferred:
 * the rollout is Codex's own log, but a turn can end without a line (a crash, a
 * kill), so a lone start is only a hint that the turn is still running.
 */
export interface CodexTurnState {
  /** `waiting`: a turn is open but stopped on the user (an approval card, a picker, a limit). */
  state: "idle" | "busy" | "waiting" | "unknown";
  /** When the evidence was written (the start or end line), or `observedAt` for unknown and screen readings. */
  updatedAt: Date;
  /** When the streamer read it. */
  observedAt: Date;
  /** Which evidence decided `state`; absent means the rollout. */
  source?: "codex-rollout" | "codex-screen";
}

/**
 * A start whose rollout has not been written for this long is reported as
 * unknown, not busy: the turn may be blocked on an approval or the process may
 * be hung. Silence is never read as the turn having ended.
 */
export const CODEX_TURN_STALE_MS = 30 * 60 * 1000;

/** A rollout no discovery has read for this long is forgotten (its owner is gone). */
const FORGET_AFTER_MS = 10 * 60 * 1000;
const CHUNK_BYTES = 1 << 20;

type TurnEvent = { kind: "start" | "end"; turnId: string; at: number };

/**
 * The root-turn event on one rollout line, or null. Root means `root_turn_id`
 * is absent (older CLIs) or equals `turn_id`; a subagent writes its own
 * start/complete into the parent's rollout while the parent turn runs, the same
 * rule `transcriptTurnEndAt` applies.
 */
export function codexRootTurnEvent(line: string): TurnEvent | null {
  if (
    !line.includes('"task_started"') &&
    !line.includes('"task_complete"') &&
    !line.includes('"turn_aborted"')
  ) {
    return null;
  }
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const p = o?.payload;
  if (o?.type !== "event_msg" || typeof p?.turn_id !== "string") return null;
  if (p.root_turn_id != null && p.root_turn_id !== p.turn_id) return null;
  const kind =
    p.type === "task_started"
      ? "start"
      : p.type === "task_complete" || p.type === "turn_aborted"
        ? "end"
        : null;
  const at = Date.parse(o.timestamp);
  if (!kind || Number.isNaN(at)) return null;
  return { kind, turnId: p.turn_id, at };
}

interface RolloutState {
  offset: number;
  partial: string;
  /** Root turns started and not yet ended: turn id → start time. */
  open: Map<string, number>;
  lastEndAt: number | null;
  readAt: number;
}

function apply(s: RolloutState, e: TurnEvent): void {
  if (e.kind === "start") {
    s.open.set(e.turnId, e.at);
    return;
  }
  const startedAt = s.open.get(e.turnId);
  s.open.delete(e.turnId);
  // Root turns run one at a time, so a turn that ended proves every root turn
  // started before it is over too (one cut short by a crash wrote no end).
  if (startedAt != null) {
    for (const [id, at] of s.open) if (at <= startedAt) s.open.delete(id);
  }
  if (s.lastEndAt === null || e.at > s.lastEndAt) s.lastEndAt = e.at;
}

/**
 * Reads each rollout incrementally (from the last offset), so a discovery pass
 * costs the bytes appended since the previous one, not the whole file.
 */
export class CodexTurnTracker {
  private readonly files = new Map<string, RolloutState>();

  async read(path: string, now = Date.now()): Promise<CodexTurnState> {
    for (const [p, s] of this.files) if (now - s.readAt > FORGET_AFTER_MS) this.files.delete(p);
    const observedAt = new Date(now);
    const unknown: CodexTurnState = { state: "unknown", updatedAt: observedAt, observedAt };
    let s = this.files.get(path);
    let mtimeMs: number;
    try {
      const st = await stat(path);
      mtimeMs = st.mtimeMs;
      // Shrunk or replaced: what we parsed no longer describes this file.
      if (!s || st.size < s.offset) {
        s = { offset: 0, partial: "", open: new Map(), lastEndAt: null, readAt: now };
        this.files.set(path, s);
      }
      await this.readAppended(path, s, st.size);
      s.readAt = now;
    } catch {
      this.files.delete(path);
      return unknown;
    }

    if (s.open.size === 1) {
      if (now - mtimeMs > CODEX_TURN_STALE_MS) return unknown;
      const [startedAt] = s.open.values();
      return { state: "busy", updatedAt: new Date(startedAt), observedAt };
    }
    // More than one open start with no end to order them: ambiguous.
    if (s.open.size === 0 && s.lastEndAt !== null) {
      return { state: "idle", updatedAt: new Date(s.lastEndAt), observedAt };
    }
    return unknown;
  }

  private async readAppended(path: string, s: RolloutState, size: number): Promise<void> {
    if (size <= s.offset) return;
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(CHUNK_BYTES);
      while (s.offset < size) {
        const { bytesRead } = await fh.read(
          buf,
          0,
          Math.min(CHUNK_BYTES, size - s.offset),
          s.offset,
        );
        if (bytesRead === 0) break;
        s.offset += bytesRead;
        const lines = (s.partial + buf.toString("utf8", 0, bytesRead)).split("\n");
        s.partial = lines.pop() ?? "";
        for (const line of lines) {
          const e = codexRootTurnEvent(line);
          if (e) apply(s, e);
        }
      }
    } finally {
      await fh.close();
    }
  }
}

/** Footer rows to read: Codex 0.171 paints its status bar above a shortcuts hint row. */
const FOOTER_ROWS = 3;
/** The active-turn timer Codex paints above the composer: `• Working (12s • esc to interrupt)`. */
const CODEX_TURN_TIMER_RE = /\bWorking\b.*\besc to interrupt\b/;

/**
 * What a captured Codex screen says right now, or null when it shows none of
 * the states it can prove. Only the footer and the turn timer are read for
 * busy/idle: transcript text above them is history.
 */
export function readCodexScreen(lines: string[]): "idle" | "busy" | "waiting" | null {
  const footer = lines
    .filter((l) => l.trim() !== "")
    .slice(-FOOTER_ROWS)
    .map((l) => codexStatusBarWords([l]));
  const ready = footer.some((l) => l.includes(CODEX_PROMPT_READY_TEXT));
  if (detectCodexCommandApproval(lines) || detectCodexBlockingPrompt(lines)) return "waiting";
  // detectCodexPicker refuses a Ready screen, so a numbered list in the
  // transcript does not read as a menu waiting on the user.
  if (detectCodexPicker(lines)) return "waiting";
  if (lines.some((l) => CODEX_TURN_TIMER_RE.test(l))) return "busy";
  if (footer.some((l) => CODEX_WORKING_STATUS_RE.test(l))) return "busy";
  if (ready) return "idle";
  return null;
}

/**
 * The rollout says what Codex logged; the screen says what it shows now. The
 * screen overrides only where its evidence is specific: a card stopped on the
 * user (`waiting`, which the rollout cannot show: it writes nothing for an
 * approval) and the turn timer (`busy`). A `Ready` footer only fills in a
 * rollout `unknown`; it never ends a rollout `busy`, because whether Codex 0.171
 * drops `Ready` while a turn runs is unverified, and a marker painted through
 * the turn is how Claude's `❯` reported "finished" as a turn started (#962).
 * Agreement keeps the rollout's reading, which is dated by the event.
 */
export function combineCodexTurn(rollout: CodexTurnState, screen: string[] | null): CodexTurnState {
  const seen = screen ? readCodexScreen(screen) : null;
  if (!seen || seen === rollout.state) return rollout;
  if (seen === "idle" && rollout.state !== "unknown") return rollout;
  const { observedAt } = rollout;
  return { state: seen, updatedAt: observedAt, observedAt, source: "codex-screen" };
}
