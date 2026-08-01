// Server feature flags: the registry, the config sources, and boot-time resolution.
//
// A feature flag gates behaviour we are not ready to make unconditional — an
// experiment, a provider quirk, a migration half-step. It is deliberately NOT
// the same mechanism as src/claude-flags.ts: those are CLI arguments handed to
// a spawned `claude` process, these change how the STREAMER itself behaves.
//
// Two rules make this safe to expose to a hand-editable server.yaml:
//   1. Booleans only. A flag is on or off; anything richer belongs in a real
//      config field with its own validation.
//   2. Resolution happens ONCE, at boot. There is no runtime mutation and no
//      PUT endpoint — a flag change means a restart, same as every other
//      startup-resolved setting (ptyGracePeriodMs, cacheDir, …). That keeps a
//      flag's value stable for the lifetime of a process, so no code has to
//      reason about it changing underneath a live session.

import { getLogger } from "./logger";

export interface FeatureFlagDefinition {
  /** Stable config/wire key. Used in server.yaml, on the CLI, and over HTTP. */
  id: string;
  /** Shipped to clients alongside the values so a UI can render it. */
  description: string;
  default: boolean;
  /** Full env var name. */
  env: string;
}

export type FeatureFlagValues = Record<string, boolean>;

export const FEATURE_FLAGS: readonly FeatureFlagDefinition[] = [
  {
    id: "codexSystemPrompt",
    description:
      "Send the built system prompt to fresh Codex sessions. Off by default: Codex has no " +
      "--system-prompt flag, so the prompt goes in the positional [PROMPT] argument, which " +
      "Codex treats as the user's opening turn rather than a system-level instruction.",
    default: false,
    env: "THREADBASE_FEATURE_CODEX_SYSTEM_PROMPT",
  },
  {
    id: "sessionRehydration",
    description:
      "Seed the session list at boot with sessions a previous streamer run left behind, so a " +
      "restart leaves them one tap from resuming instead of silently gone. On by default, with " +
      "a kill switch: it changes what GET /api/sessions contains.",
    default: true,
    env: "THREADBASE_FEATURE_SESSION_REHYDRATION",
  },
  {
    id: "ptyHost",
    description:
      "Keep live PTYs in a separate host process so a streamer restart can reconnect without " +
      "restarting the agents. Off by default until cross-platform behavior is qualified.",
    default: false,
    env: "THREADBASE_FEATURE_PTY_HOST",
  },
];

export function findFeatureFlag(id: string): FeatureFlagDefinition | undefined {
  return FEATURE_FLAGS.find((f) => f.id === id);
}

/**
 * Parse a boolean env var, tri-state.
 *
 * `undefined` means "this variable did not speak" — distinct from `false` — so
 * an unset var lets the next precedence rung (CLI, then yaml) decide instead of
 * silently forcing the flag off.
 *
 * That tri-state return is why this does not reuse one of the existing env
 * parsers (`parseIncludeAgentsEnv` in server.ts, `isTruthy` in
 * agent/agent-config.ts, the inline sets in api/middleware/cors.middleware.ts):
 * all three collapse "absent" into a boolean, which is exactly the distinction
 * the precedence chain needs. Consolidating those three is a separate change.
 */
export function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return false;
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * Drop everything that isn't a known id carrying a boolean.
 *
 * A TRUST BOUNDARY, mirroring validateFlagValues() in claude-flags.ts: values
 * arrive from a user-editable server.yaml. Unknown ids and ill-typed values are
 * dropped with a warning rather than throwing, so one stale or fat-fingered key
 * can never stop the server from booting.
 *
 * Note the deliberate non-coercion: `"true"` (a string) is dropped, not read as
 * true. A value that isn't already a boolean means the writer misunderstood the
 * format, and guessing at intent is how a flag silently ends up on.
 */
export function validateFeatureFlagValues(raw: unknown): FeatureFlagValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FeatureFlagValues = {};
  const dropped: string[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!findFeatureFlag(id) || typeof value !== "boolean") {
      dropped.push(id);
      continue;
    }
    out[id] = value;
  }
  if (dropped.length > 0) {
    getLogger("feature-flags").warn(
      `Ignoring unknown or non-boolean feature flags: ${dropped.join(", ")}`,
      {
        event: "config.feature_flags_dropped",
        dropped,
      },
    );
  }
  return out;
}

/**
 * Parse repeatable `--feature <id=bool>` CLI tokens.
 *
 * Errors are returned rather than thrown so the caller owns the exit: a typo on
 * the command line should print one legible message and stop, not surface a
 * stack trace. Unlike the yaml path this is strict — a CLI typo is a mistake the
 * operator is standing right there to fix, whereas a stale yaml key must not
 * block an unattended boot.
 */
export function parseFeatureFlagArgs(entries: string[]): {
  values: FeatureFlagValues;
  errors: string[];
} {
  const values: FeatureFlagValues = {};
  const errors: string[] = [];

  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const id = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    // A bare `--feature someFlag` reads as "turn it on", matching how bare
    // boolean flags behave everywhere else.
    const rawValue =
      eq === -1
        ? "true"
        : entry
            .slice(eq + 1)
            .trim()
            .toLowerCase();

    if (!findFeatureFlag(id)) {
      errors.push(
        `Unknown feature flag "${id}". Known flags: ${FEATURE_FLAGS.map((f) => f.id).join(", ")}`,
      );
      continue;
    }
    if (rawValue !== "true" && rawValue !== "false") {
      errors.push(`Invalid value "${rawValue}" for feature flag "${id}" — expected true/false`);
      continue;
    }
    values[id] = rawValue === "true";
  }

  return { values, errors };
}

/**
 * Resolve every flag once, at boot. Precedence, highest first:
 *
 *   env  →  CLI  →  server.yaml  →  registry default
 *
 * Env beats the CLI so an operator can flip a flag on a supervised instance
 * (launchd/systemd/Task Scheduler) whose argv is fixed — the same reason
 * THREADBASE_ALLOW_BROWSER_CORS overrides browser_cors: in server.yaml.
 *
 * The returned map is TOTAL: every registry id is present, defaults filled in.
 * Callers therefore index it without a `?? default`, and a flag added later
 * cannot reach a boolean branch as `undefined` just because an older
 * server.yaml predates it.
 */
export function resolveFeatureFlags(opts?: {
  cli?: FeatureFlagValues;
  yaml?: FeatureFlagValues;
  env?: NodeJS.ProcessEnv;
}): FeatureFlagValues {
  const env = opts?.env ?? process.env;
  const out: FeatureFlagValues = {};

  for (const def of FEATURE_FLAGS) {
    out[def.id] =
      parseBooleanEnv(env[def.env]) ?? opts?.cli?.[def.id] ?? opts?.yaml?.[def.id] ?? def.default;
  }

  return out;
}

/** Registry ids whose resolved value differs from the registry default. */
export function nonDefaultFeatureFlags(values: FeatureFlagValues): string[] {
  return FEATURE_FLAGS.filter((f) => values[f.id] !== f.default).map((f) => f.id);
}
