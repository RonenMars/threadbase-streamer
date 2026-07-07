// Permission-gate detection. Two independent signals:
//
//   1. OSC 777 escape — the deterministic TRIGGER. The PTY emits
//      `\x1b]777;notify;Claude Code;Claude needs your permission\x07`
//      (often tmux-wrapped: `\x1bPtmux;\x1b\x1b]777;notify;…\x1b\`) the instant
//      a gate opens. Confirmed in live logs (pty.chunk #53/#193). This tells us
//      a gate is open; it carries no option text.
//
//   2. Rendered option scrape — the gate's numbered options are painted into the
//      screen grid via absolute-cursor moves, so they live in the rendered
//      headless buffer (getOutputLines), not the raw byte stream. We read the
//      ACTUAL leading numbers and the `❯` cursor — the numbers are NOT a stable
//      1-based index (a gate can show "2. Yes / 3. No"), which is exactly the
//      "2 didn't take" bug this avoids.

export interface PermissionOption {
  /** The real leading number shown on screen (NOT a 1-based array index). */
  index: number;
  label: string;
  /**
   * Literal keystroke bytes that answer this option, when the number alone
   * isn't the answer (e.g. a y/N shell prompt answers "y\r"/"n\r", not "1\r").
   * Additive: OSC-777 gates omit it and the client answers via `index`; the
   * unstructured shell-prompt path (detectShellPrompt) populates it.
   */
  answerKeys?: string;
}

export interface PermissionGate {
  /** Prompt text above the options, e.g. "Claude needs your permission to use Bash". */
  prompt?: string;
  /**
   * The descriptive block above the prompt — the tool title, the command, and any
   * action description Claude paints inside the gate box (newline-joined). Lets the
   * client show WHAT is being permitted, not just "Do you want to proceed?".
   */
  detail?: string;
  options: PermissionOption[];
  /** Index value (the on-screen number) of the `❯`-highlighted option, if any. */
  cursor?: number;
}

// OSC 777 with the notify command from Claude Code. We match the stable core
// (`]777;notify;Claude Code`) rather than the whole tmux-passthrough wrapper so
// detection survives both the wrapped and unwrapped forms.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the literal OSC 777 escape
const OSC_777_RE = /\x1b\]777;notify;Claude Code;[^\x07\x1b]*/;

/** True if a raw PTY chunk contains the Claude Code OSC 777 permission notify. */
export function hasPermissionOsc(rawData: string): boolean {
  return OSC_777_RE.test(rawData);
}

// A rendered option row: optional `❯` cursor, then "N. label". Leading spaces
// from the box/indent are tolerated (the box gutter is stripped first). We
// capture N and the label separately.
const OPTION_RE = /^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$/;

// Chrome lines that are never the prompt: footers, box-drawing, prompt arrows.
const FOOTER_RE = /Enter to select|Esc to cancel|↑|↓|to navigate|to cancel/i;
const BOX_ONLY_RE = /^[\s│─┌┐└┘├┤┬┴┼╭╮╰╯╱╲=_-]+$/;
const PROMPT_ARROW_RE = /^[\s]*[❯›>]\s*$/;

// Strip leading and trailing box-drawing gutters ("│ … │") so a boxed gate
// frame parses the same as an unboxed one.
function stripGutter(line: string): string {
  return line.replace(/^\s*[│|]\s?/, "").replace(/\s*[│|]\s*$/, "");
}

/**
 * Scrape the permission gate's options + prompt from rendered screen lines.
 * Returns null when no numbered options are present (not a gate, or not painted
 * yet). Pure — no I/O.
 */
export function scrapePermissionGate(lines: string[]): PermissionGate | null {
  const options: PermissionOption[] = [];
  let cursor: number | undefined;
  let firstOptionLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = OPTION_RE.exec(stripGutter(lines[i]));
    if (!m) continue;
    const index = Number.parseInt(m[2], 10);
    if (!Number.isFinite(index)) continue;
    if (firstOptionLine === -1) firstOptionLine = i;
    if (m[1]) cursor = index; // `❯` marks the highlighted option
    options.push({ index, label: m[3] });
  }

  if (options.length === 0) return null;

  // Prompt = nearest non-empty, non-chrome line above the first option row.
  let prompt: string | undefined;
  let promptLine = -1;
  for (let i = firstOptionLine - 1; i >= 0; i--) {
    const t = stripGutter(lines[i]).trim();
    if (t.length === 0) continue;
    if (BOX_ONLY_RE.test(lines[i].trim()) || FOOTER_RE.test(t) || PROMPT_ARROW_RE.test(t)) continue;
    prompt = t || undefined;
    promptLine = i;
    break;
  }

  // Detail = the descriptive block ABOVE the prompt (tool title + command +
  // action description), newline-joined. The box top, 2+ consecutive blanks (the
  // gap to prior scrollback), or a ~6-line cap ends the block — so a
  // partial-window scrape can't vacuum unrelated terminal output.
  const detail = promptLine > 0 ? scrapeDetail(lines, promptLine) : undefined;

  return {
    ...(prompt ? { prompt } : {}),
    ...(detail ? { detail } : {}),
    options,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

const MAX_DETAIL_LINES = 6;

function scrapeDetail(lines: string[], promptLine: number): string | undefined {
  const collected: string[] = []; // bottom-up, content lines only
  let blankRun = 0;
  for (let i = promptLine - 1; i >= 0; i--) {
    // Strip the gutter first: a bare "│" is an INTERNAL blank line, not a frame
    // edge — only the true border rows ("╭──╮" / "╰──╯") are box-only once the
    // gutter is removed.
    const t = stripGutter(lines[i]).trim();
    if (BOX_ONLY_RE.test(t)) break; // box top / frame edge
    if (t.length === 0) {
      blankRun++;
      if (blankRun >= 2) break; // gap to prior scrollback
      continue; // single blank: skip (join already separates lines)
    }
    blankRun = 0;
    if (FOOTER_RE.test(t) || PROMPT_ARROW_RE.test(t)) continue; // skip chrome, keep walking
    collected.push(t);
    if (collected.length >= MAX_DETAIL_LINES) break;
  }

  return collected.length > 0 ? collected.reverse().join("\n") : undefined;
}
