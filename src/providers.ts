export const CLAUDE_CODE_PROVIDER = "claude-code" as const;
export const CODEX_CLI_PROVIDER = "codex-cli" as const;
export type ProviderName = typeof CLAUDE_CODE_PROVIDER | typeof CODEX_CLI_PROVIDER;

export function isProviderName(value: unknown): value is ProviderName {
  return value === CLAUDE_CODE_PROVIDER || value === CODEX_CLI_PROVIDER;
}

// Resolve a provider for a runner lookup. A `??` chain only defends against
// null/undefined, so a present-but-unknown value (e.g. the legacy 'threadbase'
// default from an old scanner-era cache) sails through and 501s at
// assertSupportedProvider. Coerce anything that isn't a real runner to Claude Code.
export function coerceProviderForRunner(value: unknown): ProviderName {
  return isProviderName(value) ? value : CLAUDE_CODE_PROVIDER;
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
