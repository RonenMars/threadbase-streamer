// Agent-phase detection. Answers "what is the agent doing right now" for a
// session whose status is already `running` — a refinement of that status, not
// a state with its own lifecycle.
//
// Pure — no I/O. Operates on rendered screen lines (getOutputLines), because
// the TUI paints its footer with absolute-cursor moves and it does not exist as
// a contiguous run of bytes in the raw PTY stream. This is the same constraint
// parseStatusLine documents, and the reason mobile's own attempt at this
// (tb-mobile PR #647) failed: it searched a client-side emulator that resolves
// absolute cursor moves against the wrong rows.
//
// Returns `null` when no phase is recognised. Callers must treat that as "no
// phase", never as "unchanged" — a derive that holds its previous value is how
// an indicator latches on a finished turn.
//
// Why phase is readable from a repainted footer at all, when parseStatusLine
// deliberately refuses to forward the elapsed counter from that same line: the
// counter is a continuous function of wall-clock time sampled at output events,
// so between samples it is simply wrong and the error grows without bound. A
// phase is a step function whose transitions ARE output events — the agent
// starts streaming *because* tokens began painting — so sampling at output
// events is exact for it, not approximate. The one exception is the exit edge,
// which is not an output event; that is why the phase is cleared out-of-band in
// markReady() rather than inferred from the screen going quiet.

import type { ProviderName } from "../../providers";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER } from "../../providers";
import type { AgentPhase } from "../../types";
import { CODEX_WORKING_STATUS_RE, codexScreenPreTurn, codexStatusBarLine } from "./codexScreen";

/**
 * Codex's status bar is binary: a turn walks Ready → Working → Ready with no
 * intermediate state observed on a live PTY probe, so reporting anything finer
 * would be invention. `working` is the only phase this provider can support.
 *
 * Two screens keep the composer shut without a turn being in flight, and both
 * would otherwise read as `working` before the user has submitted anything:
 * a blocking startup gate (directory trust, hooks review), and MCP boot — whose
 * status bar says "Starting", which is why this tests Working alone rather than
 * the composer-gating CODEX_BUSY_STATUS_RE that covers both words.
 */
function codexPhase(lines: string[]): AgentPhase | null {
  if (codexScreenPreTurn(lines)) return null;
  return CODEX_WORKING_STATUS_RE.test(codexStatusBarLine(lines)) ? "working" : null;
}

/**
 * Claude's footer carries a richer phase, but the marker set has not yet been
 * re-verified against a fresh PTY capture — the candidate grammar was derived
 * from two captured turns, and the distinction it rests on (output-token `↓`
 * markers, which parseStatusLine does not read, versus the input-token `↑`
 * counter, which it deliberately rejects) is too load-bearing to build on
 * unconfirmed. Reporting no phase is correct until that lands: the indicator
 * simply does not render, which is the pre-feature behaviour.
 */
function claudePhase(_lines: string[]): AgentPhase | null {
  return null;
}

/**
 * Derive the agent's phase from a rendered screen.
 *
 * An unrecognised provider yields `null` rather than falling back to a
 * provider-specific grammar. `getTerminalChromeFilter` already establishes that
 * instinct — "prefer passthrough over wrong Claude filters" — and the opposite
 * default is what let a wrong grammar run against the wrong provider in #647.
 */
export function parseAgentPhase(lines: string[], provider: ProviderName): AgentPhase | null {
  if (provider === CODEX_CLI_PROVIDER) return codexPhase(lines);
  if (provider === CLAUDE_CODE_PROVIDER) return claudePhase(lines);
  return null;
}
