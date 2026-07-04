export const CLAUDE_CODE_PROVIDER = "claude-code" as const;
export const CODEX_CLI_PROVIDER = "codex-cli" as const;
export type ProviderName = typeof CLAUDE_CODE_PROVIDER | typeof CODEX_CLI_PROVIDER;

export function isProviderName(value: unknown): value is ProviderName {
  return value === CLAUDE_CODE_PROVIDER || value === CODEX_CLI_PROVIDER;
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
