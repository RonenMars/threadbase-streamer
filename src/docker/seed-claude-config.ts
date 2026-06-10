// Seed $HOME/.claude.json so spawned interactive Claude sessions reach a usable
// prompt instead of a blocking first-run dialog (the mobile app shows an empty
// screen otherwise). On a fresh /data volume the CLI would show, in order:
// onboarding/theme picker, workspace-trust dialog, and the "custom API key
// detected" approval. Seeding these flags clears all three. (The fourth gate,
// the Bypass Permissions warning, is avoided by launching with
// `--permission-mode dontAsk` rather than `--dangerously-skip-permissions` —
// see src/pty-manager.ts.)
//
// Compiled by tsup to dist/seed-claude-config.cjs; docker/entrypoint.sh runs it
// with the plain `node` in the runtime image, before the streamer starts.
// __tests__/seed-claude-config.test.ts exercises seedClaudeConfig() directly.
import { readFileSync, writeFileSync } from "node:fs";

// Trust this workspace dir without the per-project trust dialog. Matches the
// --browse-root the streamer serves in the Fly container.
export const TRUSTED_DIR = "/data/.claude/projects";

interface ProjectEntry {
  allowedTools: string[];
  hasTrustDialogAccepted: boolean;
  hasCompletedProjectOnboarding: boolean;
}

interface ClaudeConfig {
  hasCompletedOnboarding?: boolean;
  theme?: string;
  hasTrustDialogAccepted?: boolean;
  projects?: Record<string, Partial<ProjectEntry>>;
  customApiKeyResponses?: { approved?: string[]; rejected?: string[] };
  [key: string]: unknown;
}

// Read-modify-write merge into any existing config. Idempotent: re-runs (the
// Fly volume persists .claude.json across restarts) preserve existing keys and
// never duplicate an approved key suffix.
//
// Error handling is deliberate: a fresh volume (ENOENT) starts from empty, but
// any OTHER read/parse error means the file EXISTS but is unreadable. The file
// is the system of record (userID, approved keys, feature flags) — overwriting
// it would silently truncate that state, so we throw rather than clobber.
export function seedClaudeConfig(configPath: string, apiKey: string): void {
  let config: ClaudeConfig = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`refusing to overwrite ${configPath}: ${(err as Error).message}`);
    }
    // ENOENT — expected first boot. Fall through with an empty config.
  }

  config.hasCompletedOnboarding = true;
  config.theme = config.theme || "dark";
  config.hasTrustDialogAccepted = true;

  config.projects = config.projects || {};
  config.projects[TRUSTED_DIR] = Object.assign(
    { allowedTools: [], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    config.projects[TRUSTED_DIR] || {},
  );

  // The custom-API-key approval is keyed by the last 20 chars of the API key,
  // matching how the CLI records an accepted key. The streamer maps
  // CLAUDE_API_KEY → ANTHROPIC_API_KEY at spawn, so the CLI reads the same key.
  if (apiKey) {
    const suffix = apiKey.slice(-20);
    config.customApiKeyResponses = config.customApiKeyResponses || { approved: [], rejected: [] };
    config.customApiKeyResponses.approved = config.customApiKeyResponses.approved || [];
    if (!config.customApiKeyResponses.approved.includes(suffix)) {
      config.customApiKeyResponses.approved.push(suffix);
    }
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// CLI entry: `node dist/seed-claude-config.cjs`. Reads CLAUDE_CONFIG (path) and
// CLAUDE_API_KEY from the environment. Any failure is logged with an
// [entrypoint] prefix and exits non-zero so `set -euo pipefail` aborts boot
// rather than letting the streamer start with unseeded config.
function main(): void {
  const configPath = process.env.CLAUDE_CONFIG;
  if (!configPath) {
    console.error("[entrypoint] seed-claude-config: CLAUDE_CONFIG is not set");
    process.exit(1);
  }
  try {
    seedClaudeConfig(configPath, process.env.CLAUDE_API_KEY || "");
  } catch (err) {
    console.error(`[entrypoint] ${(err as Error).message}`);
    process.exit(1);
  }
}

// tsup bundles this as CJS, so require.main === module is the right guard.
if (require.main === module) {
  main();
}
