// Detect UNSTRUCTURED blocking prompts in the rendered tail — the ones that are
// neither an AskUserQuestion menu (detectQuestionFromScreen) nor an OSC-777
// permission gate (scrapePermissionGate): a shell `read -p "… [y/N]"`, a CLI
// picker's `(y/n)`, a numbered menu printed by a plain script, etc.
//
// Scraped into the SAME structured shape the permission gate emits, so mobile
// renders it as an ordinary QuestionCard with tappable options. Each option
// carries the LITERAL keystroke that answers it (`answerKeys`) so the client
// stays dumb — it just sends those bytes. This is the ONE net-new detector;
// everything downstream (event shape, mobile rendering, answer-by-keystroke) is
// reused.
//
// Philosophy mirrors the existing detectors: conservative but false-positive
// tolerant. A spurious card is recoverable (the user ignores it or taps and the
// keys are harmless); a MISSED prompt strands a blocked PTY. We only fire on a
// tight set of patterns anchored to the LAST non-blank rendered line.

const ENTER = "\r";

export interface ShellPromptOption {
  /** Positional fallback number (1-based). Authoritative answer is `answerKeys`. */
  index: number;
  label: string;
  /** The exact bytes to send to answer this option, e.g. "y\r" or "2\r". */
  answerKeys: string;
}

export interface ShellPrompt {
  prompt: string;
  options: ShellPromptOption[];
}

// A y/N family prompt: the last line ends in a bracketed/parenthesised yes-no
// hint. Capture which letter is the default (upper-case) only to keep the label
// order natural — both options are always offered.
//   "Continue? [y/N]"  "Overwrite (y/n)?"  "Proceed [Y/n] "
const YN_RE = /[[(]\s*y\s*\/\s*n\s*[\])]/i;

// A bare confirmation with no explicit options — Enter is the only sensible
// answer. "Press enter to continue", "Press any key…", a trailing "Continue?".
const PRESS_ENTER_RE = /press\s+(enter|return|any key)/i;
const CONTINUE_RE = /\bcontinue\b\s*\??\s*$/i;

// A numbered menu row: optional cursor, "N. label" or "N) label". Same grammar
// scrapePermissionGate uses, but here the menu is a plain script's output with
// no OSC-777 and no Claude box.
const NUMBERED_RE = /^\s*(?:❯|>)?\s*(\d+)[.)]\s+(.+?)\s*$/;

// Lines that are never a prompt: Claude's own box-drawing / menu chrome. If any
// of these appear in the tail we defer to the structured detectors and bail —
// this detector is strictly the fallback for plain shell output.
const CLAUDE_CHROME_RE = /Enter to select|Esc to cancel|╭|╰|│.*│/;
const BOX_ONLY_RE = /^[\s│─┌┐└┘├┤┬┴┼╭╮╰╯╱╲=_-]+$/;

function lastNonBlank(lines: string[]): { text: string; idx: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.length > 0) return { text: t, idx: i };
  }
  return null;
}

/**
 * Scrape an unstructured shell prompt from rendered screen lines. Returns null
 * when the tail isn't a recognised prompt (prose, Claude's own UI, empty).
 * Pure — no I/O.
 */
export function detectShellPrompt(lines: string[]): ShellPrompt | null {
  // Defer to the structured detectors if Claude's TUI is on screen. Those paths
  // own AskUserQuestion / permission gates; this is plain-shell only.
  if (lines.some((l) => CLAUDE_CHROME_RE.test(l))) return null;

  const last = lastNonBlank(lines);
  if (!last) return null;

  // ── y/N family ───────────────────────────────────────────────────
  if (YN_RE.test(last.text)) {
    return {
      prompt: last.text,
      options: [
        { index: 1, label: "Yes", answerKeys: `y${ENTER}` },
        { index: 2, label: "No", answerKeys: `n${ENTER}` },
      ],
    };
  }

  // ── numbered menu ────────────────────────────────────────────────
  // Only when the LAST line is itself a numbered row (the menu just finished
  // printing and is waiting) — collect the contiguous numbered block ending it.
  if (NUMBERED_RE.test(last.text)) {
    const options: ShellPromptOption[] = [];
    for (let i = 0; i <= last.idx; i++) {
      const m = NUMBERED_RE.exec(lines[i]);
      if (!m) continue;
      const num = Number.parseInt(m[1], 10);
      if (!Number.isFinite(num)) continue;
      options.push({ index: num, label: m[2].trim(), answerKeys: `${num}${ENTER}` });
    }
    if (options.length >= 2) {
      // Prompt = nearest non-chrome line above the first numbered row.
      const firstRow = lines.findIndex((l) => NUMBERED_RE.test(l));
      let prompt = "";
      for (let i = firstRow - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.length === 0 || BOX_ONLY_RE.test(t)) continue;
        prompt = t;
        break;
      }
      return { prompt: prompt || "Select an option", options };
    }
  }

  // ── bare confirmation (Enter only) ───────────────────────────────
  if (PRESS_ENTER_RE.test(last.text) || CONTINUE_RE.test(last.text)) {
    return {
      prompt: last.text,
      options: [{ index: 1, label: "Continue", answerKeys: ENTER }],
    };
  }

  return null;
}
