export const CLAUDE_CODE_PROVIDER = "claude-code" as const;
export const CODEX_CLI_PROVIDER = "codex-cli" as const;
export type ProviderName = typeof CLAUDE_CODE_PROVIDER | typeof CODEX_CLI_PROVIDER;

// Codex conversations are read-only — the streamer cannot resume them — so a
// codex provider forces resumable=false regardless of on-disk availability.
// claude-code defers to the availability check (project path present, etc.).
export function isProviderResumable(
  provider: string | null | undefined,
  availabilityResumable: boolean,
): boolean {
  if (provider === CODEX_CLI_PROVIDER) return false;
  return availabilityResumable;
}
