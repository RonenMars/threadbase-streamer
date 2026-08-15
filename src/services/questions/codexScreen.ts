import type { PermissionOption } from "../../types";
import type { CodexGateType } from "./codexGateAnswers";

/**
 * Codex's rendered-screen regexes and predicates: readiness, busy/boot state,
 * blocking prompts (trust gate, hooks review, usage limits) and the cards built
 * from them. Pure functions of the rendered lines — no PTY, no session state.
 *
 * Lives here rather than in codex-pty-runner.ts for symmetry with the Claude
 * side, whose equivalents are already in this directory (detectPermissionGate,
 * detectQuestionFromScreen, detectShellPrompt, parseStatusLine).
 */

// Phase 0 findings (live PTY probe, not spec): Codex's status bar renders
// "Ready" (case-sensitive) once the session is actually usable, e.g.
// "gpt-5.5 medium · /path · gpt-5.5 · medium · Ready · Wo…". Two other
// observed states — "Starting" (MCP servers loading; the compose box `›`
// prefix is ALREADY visible here, so `›` alone is not a valid readiness
// signal) and "Working" (mid-turn) — must NOT be treated as ready.
export const CODEX_PROMPT_READY_TEXT = "Ready";

// Status-bar words that mean the composer is not accepting submits. Matched
// as whole words so a project path containing "Working" does not false-hit.
export const CODEX_BUSY_STATUS_RE = /\b(?:Starting|Working)\b/;

// The busy half that actually means "a turn is in flight". "Starting" is MCP
// boot, not a turn, so the two must not be conflated wherever the distinction
// matters (agent phase); for composer gating they are the same and
// CODEX_BUSY_STATUS_RE covers both.
export const CODEX_WORKING_STATUS_RE = /\bWorking\b/;

// Boot progress lines that appear *above* the status bar while MCP servers
// are still loading. The status bar may already omit "Starting" (or truncate
// "Ready") during this window — treating quiet as ready here is what stranded
// keystrokes in the compose box as newlines (session 61928fac).
//
// Do NOT match post-boot warnings ("MCP startup incomplete", "not logged in",
// "timed out after"): those stay on screen after Codex is usable. Matching
// them blocked Ready forever (session fbb5eb36) and left mobile stuck in
// `running` with a spinning send affordance.
export const CODEX_MCP_BOOT_RE = /Booting MCP|Starting MCP servers/i;

// Phase 0: a brand-new `--cd <dir>` shows a blocking directory-trust gate on
// first-ever launch — a rendered screen containing this text, with options
// "1. Yes, continue" / "2. No, quit" and a "Press enter to continue" footer.
// Does not appear on `codex resume` or on later launches in an
// already-trusted directory (Codex persists trust in ~/.codex/config.toml).
export const CODEX_TRUST_GATE_REGEX = /trust the contents/i;

// Codex's hooks-review gate: shown pre-boot (fresh start AND resume) whenever
// a configured hook is new/changed vs the trusted hashes in
// ~/.codex/config.toml [hooks.state]. Options "1. Review hooks" (highlighted
// default) / "2. Trust all and continue" / "3. Continue without trusting",
// with a "Press enter to confirm or esc to go back" footer. Live-probe
// verified: a digit keypress selects AND confirms instantly (no Enter).
export const CODEX_HOOKS_GATE_REGEX = /hooks need review/i;

// Codex's single-writer lock: `codex resume` (or `codex fork`) refuses to
// attach to a rollout another process already holds open, printing
// "already has an active writer (code -32600)" and going no further. Codex
// itself is the authority here — no pre-flight can be, because the owner may
// be a TUI, VS Code, or the desktop app, and it can attach between our probe
// and our spawn.
//
// Both spellings are accepted: the message is rendered into a 120-col TUI and
// can wrap or truncate, so the JSON-RPC code is the more durable half. Matching
// runs against the RENDERED screen, so a message split across PTY chunks (or
// reordered by absolute-cursor repaints) still matches.
export const CODEX_ACTIVE_WRITER_RE = /already has an active writer|-32600/;

/** `failureCode` set on a session killed by the writer-lock detection above. */
export const CODEX_ACTIVE_WRITER_CODE = "codex_active_writer";

// Hard usage-limit error Codex prints when the account quota is exhausted.
export const CODEX_USAGE_LIMIT_RE = /you(?:'ve| have) hit your usage limit/i;

// Soft tip Codex paints when a reset is available — often the only quota
// signal on screen when a turn never starts (hard-limit text never appears).
export const CODEX_USAGE_RESET_TIP_RE = /usage limit reset available/i;

// Interactive model-switch menu shown when a turn would exceed rate limits.
export const CODEX_RATE_LIMIT_MENU_RE = /approaching rate limits/i;

export interface CodexBlockingPrompt {
  prompt: string;
  detail?: string;
  options: PermissionOption[];
  /** Tip-only (not a hard limit / rate-limit menu). Surfaced after a failed turn. */
  soft?: boolean;
}

// Codex command approvals are rendered as an EXEC card. Unlike the startup
// gates above, selecting approval is a literal `y` and rejecting is Escape;
// the numbered rows are presentation only. Require all of the card's stable
// chrome so a command or approval word left in transcript scrollback cannot
// become a permission card.
const CODEX_COMMAND_APPROVAL_HEADING_RE = /^\s*E\s*X\s*E\s*C\s*$/i;
const CODEX_COMMAND_APPROVAL_ENV_RE = /^\s*Environment:\s*.+/i;
const CODEX_COMMAND_APPROVAL_REASON_RE = /^\s*Reason:\s*.+/i;
const CODEX_COMMAND_APPROVAL_CONFIRM_RE =
  /(?:enter|return) to (?:confirm|approve)|press (?:enter|return) to (?:confirm|approve)/i;
const CODEX_COMMAND_APPROVAL_YES_RE = /^\s*›?\s*\d+\.\s*yes\b/i;
const CODEX_COMMAND_APPROVAL_NO_RE = /^\s*›?\s*\d+\.\s*no\b/i;

/**
 * Detect Codex's rendered command-approval card. This deliberately does not
 * reuse parseCodexNumberedOptions: the visible 1/2 rows do not answer this
 * dialog, while `y` and Escape do.
 */
export function detectCodexCommandApproval(lines: string[]): CodexBlockingPrompt | null {
  // The newest dialog is the last EXEC heading in the rendered buffer; an
  // earlier one may be stale transcript content above a repaint.
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CODEX_COMMAND_APPROVAL_HEADING_RE.test(lines[i])) heading = i;
  }
  if (heading < 0) return null;
  if (
    lines.some((line) => CODEX_USAGE_LIMIT_RE.test(line) || CODEX_RATE_LIMIT_MENU_RE.test(line))
  ) {
    return null;
  }

  const card = lines.slice(heading);
  if (
    !card.some((line) => CODEX_COMMAND_APPROVAL_ENV_RE.test(line)) ||
    !card.some((line) => CODEX_COMMAND_APPROVAL_REASON_RE.test(line)) ||
    !card.some((line) => CODEX_COMMAND_APPROVAL_YES_RE.test(line)) ||
    !card.some((line) => CODEX_COMMAND_APPROVAL_NO_RE.test(line)) ||
    !card.some((line) => CODEX_COMMAND_APPROVAL_CONFIRM_RE.test(line))
  ) {
    return null;
  }

  const detail = card
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !CODEX_COMMAND_APPROVAL_HEADING_RE.test(line) &&
        !CODEX_COMMAND_APPROVAL_YES_RE.test(line) &&
        !CODEX_COMMAND_APPROVAL_NO_RE.test(line) &&
        !CODEX_COMMAND_APPROVAL_CONFIRM_RE.test(line)
      );
    })
    .join("\n");

  return {
    prompt: "Codex requests command approval",
    ...(detail ? { detail } : {}),
    options: [
      { index: 1, label: "Yes", answerKeys: "y" },
      { index: 2, label: "No", answerKeys: "\x1b" },
    ],
  };
}

/** Parse Codex's numbered TUI menus (`1. …`, `› 2. …`). */
export function parseCodexNumberedOptions(lines: string[]): PermissionOption[] {
  const options: PermissionOption[] = [];
  for (const line of lines) {
    const m = /^\s*›?\s*(\d+)\.\s+(.+?)\s*$/.exec(line.trimEnd());
    if (!m) continue;
    const label = m[2].replace(/\s*\(selected\)\s*$/i, "").trim();
    options.push({ index: Number(m[1]), label, answerKeys: `${m[1]}\r` });
  }
  return options;
}

/**
 * Usage-limit errors, the soft "reset available" tip, and the "Approaching
 * rate limits" model-picker menu. Surfaced over the permission transport so
 * mobile shows a card instead of spinning forever in `running`.
 */
export function detectCodexBlockingPrompt(lines: string[]): CodexBlockingPrompt | null {
  const screenText = lines.join("\n");
  const usageLine = lines.find((l) => CODEX_USAGE_LIMIT_RE.test(l))?.trim();
  const tipLine = lines.find((l) => CODEX_USAGE_RESET_TIP_RE.test(l))?.trim();
  const rateMenu = CODEX_RATE_LIMIT_MENU_RE.test(screenText);
  if (!usageLine && !rateMenu && !tipLine) return null;

  const soft = !usageLine && !rateMenu && Boolean(tipLine);
  const prompt =
    usageLine ??
    lines.find((l) => CODEX_RATE_LIMIT_MENU_RE.test(l))?.trim() ??
    tipLine ??
    "Codex usage limit reached";
  const detail = lines.find((l) => /try again at/i.test(l))?.trim();
  const options = parseCodexNumberedOptions(lines);
  if (options.length === 0) {
    options.push({ index: 1, label: soft ? "Dismiss" : "OK", answerKeys: "\x1b" });
  }
  return { prompt, ...(detail ? { detail } : {}), options, ...(soft ? { soft: true } : {}) };
}

/** Last non-blank rendered line — Codex paints the status bar there. */
export function codexStatusBarLine(lines: string[]): string {
  return [...lines].reverse().find((l) => l.trim() !== "") ?? "";
}

/**
 * True while the screen shows something that precedes a turn rather than being
 * one: a blocking gate dialog, or MCP boot progress. Both keep the composer
 * shut, but neither is the agent doing work — the status-bar half of
 * codexScreenBlocksComposer cannot tell them apart on its own, and reading
 * only that half is how the agent phase reported "working" during boot.
 */
export function codexScreenPreTurn(lines: string[]): boolean {
  const screenText = lines.join("\n");
  if (CODEX_HOOKS_GATE_REGEX.test(screenText) || CODEX_TRUST_GATE_REGEX.test(screenText)) {
    return true;
  }
  return CODEX_MCP_BOOT_RE.test(screenText);
}

/**
 * True while Codex must not receive composer keystrokes: gate dialogs, MCP
 * boot progress, or a Starting/Working status bar. Shared by boot detection,
 * the flat fallback, and mid-session idle re-detect.
 */
export function codexScreenBlocksComposer(lines: string[]): boolean {
  if (codexScreenPreTurn(lines)) return true;
  return CODEX_BUSY_STATUS_RE.test(codexStatusBarLine(lines));
}

/** Authoritative Ready: status-bar word present and screen not otherwise busy. */
export function codexScreenShowsReady(lines: string[]): boolean {
  if (codexScreenBlocksComposer(lines)) return false;
  return codexStatusBarLine(lines).includes(CODEX_PROMPT_READY_TEXT);
}

/**
 * Soft idle for a truncated Ready bar: compose `›` / `>` is up and nothing
 * busy is on screen. Not used as a sole boot-ready signal on quiet — `›`
 * appears during Starting — but the flat fallback requires it (or Ready)
 * before settling so a model-only status line is not mistaken for usable.
 */
export function codexScreenLooksIdle(lines: string[]): boolean {
  if (codexScreenBlocksComposer(lines)) return false;
  if (codexScreenShowsReady(lines)) return true;
  // Compose prefix: `›` (Codex default) or `>` (some Windows/ConPTY paints).
  // Require start-of-line so URLs like `https://…` do not false-hit.
  return lines.some((l) => /^\s*[›>]\s/.test(l) || l.includes("›"));
}

// Build the question card for a gate, broadcast over the existing `permission`
// WS transport (mobile already renders these as tappable cards). Real options
// keep their literal on-screen digits; the synthetic "remember" variants
// continue the numbering and are intercepted in sendKeys() — they never reach
// the PTY as-is. answerKeys mirrors `${index}\r` so old clients (index
// fallback) and new clients (answerKeys) send identical bytes.
// "1. Review hooks" is deliberately omitted: a per-hook review screen is a
// desktop affordance with no workable mobile rendering.
export function gateCard(
  gate: CodexGateType,
  lines: string[],
): { prompt: string; options: PermissionOption[] } {
  if (gate === "hooks") {
    const countLine = lines.find((l) => /new or changed/i.test(l))?.trim();
    return {
      prompt: [
        "Hooks need review",
        countLine,
        "Hooks can run outside the sandbox after you trust them.",
      ]
        .filter(Boolean)
        .join(" — "),
      options: [
        { index: 2, label: "Trust all and continue", answerKeys: "2\r" },
        { index: 3, label: "Continue without trusting (hooks won't run)", answerKeys: "3\r" },
        {
          index: 4,
          label: "Trust all and continue (remember for all projects)",
          answerKeys: "4\r",
        },
        {
          index: 5,
          label: "Continue without trusting (remember for all projects)",
          answerKeys: "5\r",
        },
      ],
    };
  }
  return {
    prompt:
      lines.find((l) => CODEX_TRUST_GATE_REGEX.test(l))?.trim() ??
      "Do you trust the contents of this directory?",
    options: [
      { index: 1, label: "Yes, continue", answerKeys: "1\r" },
      { index: 2, label: "No, quit", answerKeys: "2\r" },
      { index: 3, label: "Yes, continue (remember for all projects)", answerKeys: "3\r" },
    ],
  };
}
