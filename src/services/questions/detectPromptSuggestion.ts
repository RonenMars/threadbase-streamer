import type { Terminal } from "@xterm/headless";

// Claude Code's composer draws its "❯" prompt on the row between two full-width
// ─ rules. A predicted next prompt ("add type hints and a docstring") is
// painted into that row as SGR 2 (faint) text — `ESC[2m … ESC[22m`, verified
// against Claude Code v2.1.278 — where text the user typed carries no dim flag.
// The rendered *text* is identical either way, so the only thing that tells a
// suggestion from real input is the cell attribute, which the text scrape
// (translateToString) throws away.
const COMPOSER_RULE_RE = /^\s*─{8,}\s*$/;
const PROMPT_GLYPH = "❯ ";
// Older Claude Code builds put a dim example prompt in an empty composer
// (`Try "fix typecheck errors"`, v2.1.6). That is a tip, not a prediction.
const PLACEHOLDER_TIP_RE = /^Try "/;

/**
 * Read the bottom-most composer row of a headless screen and return its text
 * iff every non-blank cell after the prompt glyph is dim; otherwise `null`.
 * Reads the visible viewport only, so scrollback (an old `❯ <user message>`
 * echo, which is never dim and never rule-bracketed) cannot match.
 */
export function readPromptSuggestion(term: Terminal): string | null {
  const buf = term.buffer.active;
  const text = (y: number) => buf.getLine(y)?.translateToString(true) ?? "";
  for (let y = buf.baseY + term.rows - 2; y > buf.baseY; y--) {
    const row = text(y);
    if (!row.startsWith(PROMPT_GLYPH)) continue;
    if (!COMPOSER_RULE_RE.test(text(y - 1)) || !COMPOSER_RULE_RE.test(text(y + 1))) continue;
    const suggestion = row.slice(PROMPT_GLYPH.length).trim();
    if (!suggestion || PLACEHOLDER_TIP_RE.test(suggestion)) return null;
    const line = buf.getLine(y);
    // By column, not string index: a wide glyph spans two cells but one char.
    for (let x = PROMPT_GLYPH.length; x < term.cols; x++) {
      const cell = line?.getCell(x);
      if (cell?.getChars().trim() && !cell.isDim()) return null;
    }
    return suggestion;
  }
  return null;
}
