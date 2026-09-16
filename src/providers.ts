export const CLAUDE_CODE_PROVIDER = "claude-code" as const;
export const CODEX_CLI_PROVIDER = "codex-cli" as const;
export const CURSOR_PROVIDER = "cursor" as const;
/** Live PTY on main shipped this wire name; accept it and emit `cursor`. */
export const LEGACY_CURSOR_PROVIDER = "cursor-cli" as const;

export const PROVIDER_NAMES = [CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER, CURSOR_PROVIDER] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function canonicalizeProviderName(value: unknown): ProviderName | undefined {
  if (value === LEGACY_CURSOR_PROVIDER) return CURSOR_PROVIDER;
  if (typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value)) {
    return value as ProviderName;
  }
  return undefined;
}

export function isProviderName(value: unknown): value is ProviderName {
  return canonicalizeProviderName(value) !== undefined;
}

/** The argv[0] we look for / tell the user to install. */
export function commandNameForProvider(provider: ProviderName): string {
  switch (canonicalizeProviderName(provider) ?? provider) {
    case CLAUDE_CODE_PROVIDER:
      return "claude";
    case CODEX_CLI_PROVIDER:
      return "codex";
    case CURSOR_PROVIDER:
      return "agent";
    default:
      return "claude";
  }
}

// Resolve a provider for a runner lookup. A `??` chain only defends against
// null/undefined, so a present-but-unknown value (e.g. the legacy 'threadbase'
// default from an old scanner-era cache) sails through and 501s at
// assertSupportedProvider. Coerce anything that isn't a real runner to Claude Code.
export function coerceProviderForRunner(value: unknown): ProviderName {
  return canonicalizeProviderName(value) ?? CLAUDE_CODE_PROVIDER;
}

// Codex resume is implemented and verified (Phase 0: `codex resume <id>
// --cd <dir>` replays the prior transcript end-to-end) — codex-cli now
// defers to the same availability check as claude-code (project path
// present, etc.) instead of forcing resumable=false unconditionally.
// `provider` is kept in the signature (unused) so call sites don't need to
// change if resumability ever needs to differentiate by provider again.
export function isProviderResumable(
  _provider: string | null | undefined,
  availabilityResumable: boolean,
): boolean {
  return availabilityResumable;
}
