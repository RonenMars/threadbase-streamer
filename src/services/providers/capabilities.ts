import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER, type ProviderName } from "../../providers";

/**
 * Provider capability declarations (C2).
 * See docs/architecture/2026-07-24-provider-compatibility.md.
 *
 * Every field here is a branch that ALREADY exists somewhere in the codebase —
 * this promotes it from an implied code path to queryable data. The point is
 * that a client can ask what a provider supports instead of discovering it by
 * attempting an action and getting a 501 or a silently wrong result.
 */
export interface ProviderCapabilities {
  /**
   * How a fresh session gets its id.
   * `explicit`   — we generate it and pass it in (Claude: `--session-id <uuid>`).
   * `late-bound` — the CLI creates its own and we discover it afterwards
   *                (Codex: no `--session-id` equivalent, so the rollout id is
   *                found by watching the sessions dir after spawn).
   */
  freshSessionId: "explicit" | "late-bound";
  /** Whether the CLI can replay a prior transcript from an id. */
  resume: "native" | "unsupported";
  /**
   * How a system prompt reaches the CLI.
   * `flag`       — a dedicated flag (Claude: `--system-prompt`).
   * `positional` — passed as the opening turn (Codex has no flag).
   */
  systemPrompt: "flag" | "positional" | "unsupported";
  /** We can detect and parse structured question menus from the TUI. */
  structuredQuestions: boolean;
  /** We can detect permission/trust gates and answer them programmatically. */
  permissionGates: boolean;
  /**
   * We can send input to a live session. False means read-only observation —
   * the honest state for a provider whose input path we do not understand.
   */
  liveControl: boolean;
}

/**
 * Provider versions an adapter's parsing and detection were captured against.
 *
 * `captured` lists the versions we hold fixtures for. `min`/`max` bound the
 * range we claim to support. A provider outside that range still runs — it just
 * reports a compatibility warning rather than pretending to be verified.
 */
export interface VerifiedAgainst {
  min?: string;
  max?: string;
  captured: string[];
}

/**
 * Outcome of normalizing one native-history line.
 *
 * The `ignored` / `unknown` split is the reason this type exists. Today every
 * non-chat line returns null (src/utils/codexConversationLine.ts), so "a
 * session_meta header we deliberately skip" and "a shape this adapter has never
 * seen" are indistinguishable — and a provider schema change therefore renders
 * an empty conversation with no error at all.
 */
export type NormalizeResult =
  /** Recognized chat content, normalized to the client-facing shape. */
  | { kind: "message"; line: string }
  /** Recognized, but deliberately not rendered (headers, dupes, injected context). */
  | { kind: "ignored"; reason: string }
  /** NOT recognized. Counted and surfaced as a compatibility signal. */
  | { kind: "unknown"; raw: string; reason: string };

/**
 * The descriptive half of a provider integration. `SessionRunner` (types.ts) is
 * the behavioural half — how to spawn and drive the CLI. This is what the
 * integration claims about itself, so adding a provider means implementing a
 * declared surface rather than copying a runner and hoping.
 */
export interface ProviderAdapter {
  name: ProviderName;
  capabilities: ProviderCapabilities;
  verifiedAgainst: VerifiedAgainst;
  /** Installed provider version, or null when it cannot be determined. */
  detectVersion(): Promise<string | null>;
  /** Classify one raw native-history line. Never silently discards. */
  normalizeLine(line: string): NormalizeResult;
}

// ─── Declared capabilities ────────────────────────────────────────────
//
// Each value below is sourced from existing behaviour, not aspiration:
//   Claude  — `--session-id` (pty-manager.ts), `--resume`, `--system-prompt`,
//             OSC-777 gates + "Enter to select" menus (services/questions/*).
//   Codex   — no fresh-session id (codex-pty-runner.ts: "start() always means
//             resume"), `codex resume <id>`, prompt passed positionally, and
//             trust/hooks gates detected by regex. Codex has no equivalent of
//             Claude's AskUserQuestion menu that we parse, hence
//             structuredQuestions: false.

export const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  freshSessionId: "explicit",
  resume: "native",
  systemPrompt: "flag",
  structuredQuestions: true,
  permissionGates: true,
  liveControl: true,
};

export const CODEX_CLI_CAPABILITIES: ProviderCapabilities = {
  freshSessionId: "late-bound",
  resume: "native",
  systemPrompt: "positional",
  structuredQuestions: false,
  permissionGates: true,
  liveControl: true,
};

/**
 * Capabilities for a provider we do not recognize.
 *
 * This is the generic-terminal fallback: stream bytes, accept input, and claim
 * no semantic understanding. It exists because the current behaviour is worse —
 * `coerceProviderForRunner` (providers.ts) silently maps an unknown provider to
 * claude-code, so an unrecognized CLI gets driven with Claude's argv, Claude's
 * markers, and Claude's env scrubbing. Admitting we don't know beats asserting
 * the wrong thing.
 */
export const GENERIC_TERMINAL_CAPABILITIES: ProviderCapabilities = {
  freshSessionId: "late-bound",
  resume: "unsupported",
  systemPrompt: "unsupported",
  structuredQuestions: false,
  permissionGates: false,
  liveControl: true,
};

export function capabilitiesFor(provider: ProviderName): ProviderCapabilities {
  switch (provider) {
    case CLAUDE_CODE_PROVIDER:
      return CLAUDE_CODE_CAPABILITIES;
    case CODEX_CLI_PROVIDER:
      return CODEX_CLI_CAPABILITIES;
  }
}
