import type { FeatureFlagValues } from "../src/feature-flags";

/**
 * `--no-e2ee` folded into the CLI rung of the feature-flag resolution.
 *
 * A `serve` option and nothing else (D-8): no `server.yaml` key, no
 * `THREADBASE_*` variable of its own. It is sugar for `--feature e2ee=false`
 * and lands on the same rung, so the documented precedence decides the run —
 * which means `THREADBASE_FEATURE_E2EE=1` still wins, because `env` outranks
 * `cli`. That is deliberate: the collision between D-8 and §6.5 is R2's
 * escalation to the user, and implementing an exception here would decide it.
 *
 * It lives in its own module for the reason `boot-log.ts` does: `cli/index.ts`
 * runs `program.parse()` on import and cannot be loaded from a test.
 */
export function applyNoE2ee(
  featureFlags: FeatureFlagValues | undefined,
  /** Commander's value for the negated option: `false` when `--no-e2ee` was passed. */
  e2eeOption: unknown,
): { values: FeatureFlagValues | undefined; error?: string } {
  if (e2eeOption !== false) return { values: featureFlags };
  // Two spellings of one switch must not disagree. Refusing the boot is the
  // same strictness `--feature` already applies to a typo, and the alternative
  // — silently picking a winner — is how an operator ends up believing
  // encryption is off when it is on.
  if (featureFlags?.e2ee === true) {
    return {
      values: featureFlags,
      error: "--no-e2ee contradicts --feature e2ee=true; pass one or the other",
    };
  }
  return { values: { ...featureFlags, e2ee: false } };
}
