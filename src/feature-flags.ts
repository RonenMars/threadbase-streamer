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

/** Spec for one flag in the keyed registry. The id is the object key, not a field. */
export interface FeatureFlagSpec {
  /** Shipped to clients alongside the values so a UI can render it. */
  description: string;
  default: boolean;
  /** Full env var name. */
  env: string;
}

/** Wire shape: the keyed spec plus its id, for GET /api/config/feature-flags. */
export interface FeatureFlagDefinition extends FeatureFlagSpec {
  /** Stable config/wire key. Used in server.yaml, on the CLI, and over HTTP. */
  id: FeatureFlagId;
}

/**
 * Values arriving from a config source. PARTIAL on purpose: server.yaml, the
 * CLI and ServerConfig each speak about the flags they mention and stay silent
 * on the rest, which is what lets the precedence chain fall through.
 */
export type FeatureFlagValues = Partial<Record<FeatureFlagId, boolean>>;

/** Every flag, resolved. Total — see resolveFeatureFlags(). */
export type ResolvedFeatureFlags = Record<FeatureFlagId, boolean>;

/**
 * Which rung of the precedence chain decided a flag.
 *
 * Kept because the resolved boolean alone cannot answer "why is this on?", and
 * that is the first question asked of a flag that is on when nobody expected it.
 * `override` is the legacy ServerConfig field (see resolveFeatureFlags).
 */
export type FeatureFlagSource = "override" | "env" | "cli" | "yaml" | "default";

export interface FeatureFlagResolution {
  values: ResolvedFeatureFlags;
  sources: Record<FeatureFlagId, FeatureFlagSource>;
}

/**
 * The registry, keyed by flag name.
 *
 * Prefer `FEATURE_FLAGS.ptyHost` over a string lookup. A typo is a compile
 * error; `findFeatureFlag("…")` is only for untrusted yaml/CLI tokens.
 *
 * `as const` + `keyof` is what makes `flags.ptyHsot` a compile error instead of
 * `undefined`. A TS enum would add a runtime object without a stronger type.
 */
export const FEATURE_FLAGS = {
  codexSystemPrompt: {
    description:
      "Send the built system prompt to fresh Codex sessions. Off by default: Codex has no " +
      "--system-prompt flag, so the prompt goes in the positional [PROMPT] argument, which " +
      "Codex treats as the user's opening turn rather than a system-level instruction.",
    default: false,
    env: "THREADBASE_FEATURE_CODEX_SYSTEM_PROMPT",
  },
  sessionRehydration: {
    description:
      "Seed the session list at boot with sessions a previous streamer run left behind, so a " +
      "restart leaves them one tap from resuming instead of silently gone. On by default, with " +
      "a kill switch: it changes what GET /api/sessions contains.",
    default: true,
    env: "THREADBASE_FEATURE_SESSION_REHYDRATION",
  },
  liveActivityPush: {
    description:
      "Drive iOS Live Activity surfaces for running sessions. Off by default: the streamer half " +
      "needs an APNs p8 and a registered push-to-start token, and without both, mobile falls back " +
      "to starting the activity locally — which freezes the moment the app backgrounds and " +
      "expires silently after ~8h. Mobile reads this flag and skips its local path too, so one " +
      "switch turns the whole surface off.",
    default: false,
    env: "THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH",
  },
  e2ee: {
    description:
      "Application-layer encryption between a paired device and this server, independent of TLS, " +
      "so a tunnel or a LAN observer on the path carries ciphertext. Off by default: it is " +
      "negotiated per device, never forced, because released mobile builds cannot be " +
      "force-updated and a server that demanded it would break every one of them.",
    default: false,
    env: "THREADBASE_FEATURE_E2EE",
  },
  accessProbe: {
    description:
      "At boot, ask this server's own public URL what an unauthenticated device would get, and warn " +
      "if an edge gate (Cloudflare Access) answers instead of the server. On by default because the " +
      "failure it catches is silent and expensive: a sealed request carries no Authorization header, " +
      "so an interactive Access application refuses it before the tunnel and the device reports that " +
      "pairing failed — blaming the server, which never saw the request. One probe, one line, never a " +
      "retry and never a refusal to start.",
    default: true,
    env: "THREADBASE_FEATURE_ACCESS_PROBE",
  },
  ptyHost: {
    description:
      "Keep live PTYs in a separate host process so a streamer restart can reconnect without " +
      "restarting the agents. Off by default until cross-platform behavior is qualified.",
    default: false,
    env: "THREADBASE_FEATURE_PTY_HOST",
  },
} as const satisfies Record<string, FeatureFlagSpec>;

/**
 * The registry's ids as a union, derived rather than declared.
 *
 * This is what makes `flags.ptyHsot` a compile error instead of `undefined`.
 * Under the old `Record<string, boolean>` an index signature accepted any key,
 * so a typo in a consumer read as falsy and silently disabled the feature it
 * was meant to gate — the exact failure the "total map" contract exists to
 * prevent, reachable through the one door that contract left open.
 */
export type FeatureFlagId = keyof typeof FEATURE_FLAGS;

/**
 * The yaml / `--feature` ids, in registry order.
 *
 * These are the `FEATURE_FLAGS` object keys — not the `THREADBASE_FEATURE_*`
 * env names. `feature_flags: {"ptyHost":true}` is valid;
 * `{"THREADBASE_FEATURE_PTY_HOST":true}` is dropped as unknown.
 */
export const FEATURE_FLAG_IDS = Object.keys(FEATURE_FLAGS) as FeatureFlagId[];

/**
 * Ordered list for iteration and the HTTP registry.
 *
 * The wire shape stays an array of `{ id, description, default, env }` so a
 * keyed in-process registry is not a breaking GET /api/config/feature-flags
 * change. Each `id` is the matching `FEATURE_FLAGS` key.
 */
export const FEATURE_FLAG_LIST: readonly FeatureFlagDefinition[] = FEATURE_FLAG_IDS.map((id) => ({
  id,
  ...FEATURE_FLAGS[id],
}));

export function isFeatureFlagId(id: string): id is FeatureFlagId {
  return Object.hasOwn(FEATURE_FLAGS, id);
}

/** Typed lookup. The flag is always present; unknown names do not type-check. */
export function getFeatureFlag<K extends FeatureFlagId>(id: K) {
  return { id, ...FEATURE_FLAGS[id] };
}

/**
 * Look a flag up by an unvalidated string (yaml keys, `--feature` tokens).
 *
 * In-process code should use `FEATURE_FLAGS.ptyHost` or `getFeatureFlag("ptyHost")`.
 */
export function findFeatureFlag(id: string): FeatureFlagDefinition | undefined {
  if (!isFeatureFlagId(id)) return undefined;
  return getFeatureFlag(id);
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
    const def = findFeatureFlag(id);
    if (!def || typeof value !== "boolean") {
      dropped.push(id);
      continue;
    }
    out[def.id] = value;
  }
  if (dropped.length > 0) {
    getLogger("feature-flags").warn(
      `Ignoring unknown or non-boolean feature flags: ${dropped.join(", ")}. ` +
        `Known ids (FEATURE_FLAGS keys, not env names): ${FEATURE_FLAG_IDS.join(", ")}`,
      {
        event: "config.feature_flags_dropped",
        dropped,
        known: FEATURE_FLAG_IDS,
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

    const def = findFeatureFlag(id);
    if (!def) {
      errors.push(
        `Unknown feature flag "${id}". Known flags (FEATURE_FLAGS keys, not env names): ${FEATURE_FLAG_IDS.join(", ")}`,
      );
      continue;
    }
    if (rawValue !== "true" && rawValue !== "false") {
      errors.push(`Invalid value "${rawValue}" for feature flag "${id}" — expected true/false`);
      continue;
    }
    values[def.id] = rawValue === "true";
  }

  return { values, errors };
}

/**
 * Resolve every flag once, at boot. Precedence, highest first:
 *
 *   override  →  env  →  CLI  →  server.yaml  →  registry default
 *
 * Env beats the CLI so an operator can flip a flag on a supervised instance
 * (launchd/systemd/Task Scheduler) whose argv is fixed — the same reason
 * THREADBASE_ALLOW_BROWSER_CORS overrides browser_cors: in server.yaml.
 *
 * `override` is the legacy explicit ServerConfig field (codexSystemPromptEnabled),
 * kept so embedders and tests that set it directly keep working. It is a real
 * rung here rather than a mutation applied to the finished map afterwards: the
 * old shape meant the resolver was not actually the single source of truth, and
 * an override was invisible to anything reporting where a value came from.
 *
 * The returned `values` map is TOTAL: every registry id is present, defaults
 * filled in. Callers therefore index it without a `?? default`, and a flag added
 * later cannot reach a boolean branch as `undefined` just because an older
 * server.yaml predates it. `sources` is total for the same reason.
 */
export function resolveFeatureFlags(opts?: {
  override?: FeatureFlagValues;
  cli?: FeatureFlagValues;
  yaml?: FeatureFlagValues;
  env?: NodeJS.ProcessEnv;
}): FeatureFlagResolution {
  const env = opts?.env ?? process.env;
  const values = {} as ResolvedFeatureFlags;
  const sources = {} as Record<FeatureFlagId, FeatureFlagSource>;

  for (const def of FEATURE_FLAG_LIST) {
    // Written as an ordered list rather than a `??` chain because the chain
    // discards which rung won, and that is the answer to the only question
    // anyone asks of a surprising flag.
    const rungs: ReadonlyArray<[FeatureFlagSource, boolean | undefined]> = [
      ["override", opts?.override?.[def.id]],
      ["env", parseBooleanEnv(env[def.env])],
      ["cli", opts?.cli?.[def.id]],
      ["yaml", opts?.yaml?.[def.id]],
    ];
    const won = rungs.find(([, v]) => v !== undefined);
    values[def.id] = won ? (won[1] as boolean) : def.default;
    sources[def.id] = won ? won[0] : "default";
  }

  return { values, sources };
}

/** Registry ids whose resolved value differs from the registry default. */
export function nonDefaultFeatureFlags(values: ResolvedFeatureFlags): FeatureFlagId[] {
  return FEATURE_FLAG_LIST.filter((f) => values[f.id] !== f.default).map((f) => f.id);
}

/**
 * One line describing the whole resolution: `id=value(source)`, every flag.
 *
 * Replaces a boot log that printed only the ids differing from their defaults
 * under the heading "Feature flags active". That heading was wrong for any
 * flag whose default is ON — disabling `sessionRehydration` made it appear in
 * a list of active flags, stating the opposite of what had happened. Printing
 * the value removes the ambiguity, and printing every flag means the log
 * answers "what was this process running with" instead of only ever hinting.
 */
export function describeFeatureFlags(resolution: FeatureFlagResolution): string {
  return FEATURE_FLAG_LIST.map(
    (f) => `${f.id}=${resolution.values[f.id]}(${resolution.sources[f.id]})`,
  ).join(" ");
}
