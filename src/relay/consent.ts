import type { FeatureFlagSource } from "../feature-flags";

export interface RelayConsentDeps {
  /** The resolved `relay` flag, and which rung of the resolver set it. */
  enabled: boolean;
  source: FeatureFlagSource;
  /** The tunnel URL this run would dial. */
  endpoint: string;
  /** `relay_consent` from server.yaml. */
  consent: string | undefined;
  /** A person is at a terminal and this is not a supervised run. */
  interactive: boolean;
  askFirstRun: (endpoint: string) => Promise<boolean>;
  confirmEnabled: (endpoint: string, source: string) => Promise<boolean>;
  approve: (endpoint: string) => void;
  decline: () => void;
  clearConsent: () => void;
  warn: (message: string) => void;
}

const SOURCE_LABEL: Record<FeatureFlagSource, string> = {
  override: "an embedder override",
  env: "the THREADBASE_FEATURE_RELAY environment variable",
  cli: "a --feature relay=true argument",
  yaml: "feature_flags in ~/.threadbase/server.yaml",
  default: "the default",
};

/**
 * Whether this run dials the relay. The relay is a third party that sees who
 * connects, so a switch is not consent: the only way it runs is a recorded yes
 * to this endpoint, and with no one to ask it does not run.
 */
export async function decideRelay(d: RelayConsentDeps): Promise<boolean> {
  if (!d.enabled) {
    // A relay turned off by hand forgets the yes, so turning it back on asks again.
    if (d.consent !== undefined) d.clearConsent();
    // Only silence is a first run; an explicit `false` was an answer.
    if (d.source === "default" && d.interactive && (await d.askFirstRun(d.endpoint))) {
      d.approve(d.endpoint);
      return true;
    }
    if (d.source === "default" && d.interactive) d.decline();
    return false;
  }
  if (d.consent === d.endpoint) return true;
  if (!d.interactive) {
    d.warn(
      `The relay is enabled by ${SOURCE_LABEL[d.source]} but was never confirmed, and there is no terminal to ask on. ` +
        "Starting without it. Run `tb-streamer relay enable` to confirm.",
    );
    return false;
  }
  if (await d.confirmEnabled(d.endpoint, SOURCE_LABEL[d.source])) {
    d.approve(d.endpoint);
    return true;
  }
  d.decline();
  return false;
}
