// Status-line parsing. Claude Code paints a footer at the bottom of the screen
// carrying the facts mobile wants to show natively instead of rendering raw
// terminal text:
//
//   "  Opus 4.8 (1M context) │ ~/dev/ai-tools/tb-streamer  main ✎ │  26.5.0 23:41 │ ⚓4"
//   "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"
//   "                                          ● high · /effort"
//
// Only stable facts are extracted (model, effort, permission mode). The elapsed
// "(56s · ↑ 3.4k tokens)" counter is deliberately NOT parsed: Claude repaints it
// only when it has other output to draw, so any value we forwarded would be
// stale the moment it arrived. The client animates elapsed time locally instead.
//
// Pure — no I/O. Operates on rendered screen lines (getOutputLines), because the
// footer is painted with absolute-cursor moves and does not exist as a
// contiguous run of bytes in the raw PTY stream.

export interface StatusLineInfo {
  /** e.g. "Opus 4.8 (1M context)" or "Sonnet 5". */
  model?: string;
  /** e.g. "high" — the reasoning-effort tier. */
  effort?: string;
  /** e.g. "accept edits on" — the active permission mode. */
  permissionMode?: string;
}

// Model segment: the footer row is "│"-delimited and the model is its first
// cell. Anchored on a known family name so an arbitrary first cell (a path, a
// git branch) can't be mistaken for a model.
const MODEL_RE = /(Opus|Sonnet|Haiku|Fable)\s+[\d.]+(?:\s*\([^)]*\))?/;

// Effort row: "● high · /effort". The bullet and the "/effort" suffix together
// make this unambiguous; the tier itself is captured open-endedly so a new tier
// name doesn't silently parse as undefined.
const EFFORT_RE = /●\s*([A-Za-z]+)\s*·\s*\/effort/;

// Permission-mode row: "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents".
// Stop at the parenthetical so the hint text isn't captured as part of the mode.
const PERMISSION_MODE_RE = /⏵⏵\s*([^(·\n]+?)\s*(?:\(|·|$)/;

/**
 * Extract model / effort / permission mode from rendered screen lines.
 * Returns an empty object when the footer isn't on screen — callers treat every
 * field as optional, so a missed parse degrades to "not reported" rather than
 * throwing or inventing a value.
 *
 * Scans from the bottom: the footer is the last thing painted, and older
 * scrollback can contain text that looks like a footer row.
 */
export function parseStatusLine(lines: string[]): StatusLineInfo {
  const info: StatusLineInfo = {};

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    if (info.effort === undefined) {
      const m = EFFORT_RE.exec(line);
      if (m) info.effort = m[1];
    }
    if (info.permissionMode === undefined) {
      const m = PERMISSION_MODE_RE.exec(line);
      if (m) info.permissionMode = m[1].trim();
    }
    if (info.model === undefined) {
      const m = MODEL_RE.exec(line);
      if (m) info.model = m[0].replace(/\s+/g, " ").trim();
    }

    if (info.model && info.effort && info.permissionMode) break;
  }

  return info;
}
