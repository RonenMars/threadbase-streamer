import { execFile } from "child_process";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER, type ProviderName } from "../../providers";
import { capabilitiesFor, type ProviderCapabilities, type VerifiedAgainst } from "./capabilities";

/**
 * Provider version detection and compatibility reporting (C2).
 * See docs/architecture/2026-07-24-provider-compatibility.md.
 *
 * Our parsing and TUI detection are calibrated against specific provider
 * versions — the fixtures under __tests__/fixtures/providers/<provider>/<version>
 * record which. This module compares what is actually installed against that,
 * so drift is reported instead of surfacing as a mysteriously stuck session.
 *
 * A warning is never a refusal. A provider working slightly outside our verified
 * range is vastly better than us blocking it.
 */

/** Versions each adapter's fixtures were captured against. */
export const VERIFIED_AGAINST: Record<ProviderName, VerifiedAgainst> = {
  [CLAUDE_CODE_PROVIDER]: { captured: ["2.1.214"], min: "2.1.0" },
  [CODEX_CLI_PROVIDER]: { captured: ["0.140.0-alpha.19"], min: "0.140.0" },
};

export type ProviderWarningCode =
  /** The CLI is not installed, or not on PATH. */
  | "provider_not_found"
  /** Installed, but we could not read a version from it. */
  | "version_undetectable"
  /** Installed and readable, but outside the range our fixtures cover. */
  | "version_unverified";

export interface ProviderWarning {
  code: ProviderWarningCode;
  message: string;
}

export interface ProviderHealth {
  name: ProviderName;
  available: boolean;
  version: string | null;
  verifiedAgainst: VerifiedAgainst;
  capabilities: ProviderCapabilities;
  warnings: ProviderWarning[];
}

const VERSION_TIMEOUT_MS = 3_000;

/**
 * Run `<exe> --version` and return the first version-looking token.
 *
 * Deliberately tolerant: providers format this line differently and change it
 * between releases, so we scrape a semver-shaped substring rather than assume a
 * layout. Any failure yields null, which the caller treats as "unverified"
 * rather than "incompatible" — an unreadable version is not evidence of a
 * problem with the provider.
 */
export function parseVersionOutput(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

function runVersion(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return resolve(null);
      resolve(parseVersionOutput(`${stdout}${stderr}`));
    });
  });
}

/**
 * Compare a detected version against the range an adapter claims to cover.
 *
 * Only `min` is enforced as a floor. There is deliberately no upper bound check
 * beyond `max` when set: providers release constantly, and refusing to run
 * against a version merely newer than our newest fixture would break users on
 * every provider update for no evidence of an actual incompatibility.
 */
export function compareToVerified(
  version: string | null,
  verified: VerifiedAgainst,
): ProviderWarning | null {
  if (version === null) {
    return {
      code: "version_undetectable",
      message:
        "Could not determine the installed version, so compatibility is unverified. " +
        "Parsing and prompt detection may not match this build.",
    };
  }
  if (verified.captured.includes(version)) return null;

  const below = verified.min != null && compareSemver(version, verified.min) < 0;
  const above = verified.max != null && compareSemver(version, verified.max) > 0;
  if (!below && !above && verified.max != null) return null;
  if (!below && verified.max == null && !isNewerThanAllCaptured(version, verified.captured)) {
    return null;
  }

  return {
    code: "version_unverified",
    message:
      `Installed version ${version} is outside the range these adapters were verified against ` +
      `(captured: ${verified.captured.join(", ")}). It will still run; parsing or prompt ` +
      "detection may differ.",
  };
}

function isNewerThanAllCaptured(version: string, captured: string[]): boolean {
  return captured.every((c) => compareSemver(version, c) > 0);
}

/**
 * Compare two semver-ish strings. Prerelease suffixes sort BELOW the same
 * release (0.140.0-alpha.19 < 0.140.0), matching semver, so a prerelease we
 * captured does not read as newer than the release it precedes.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1; // release > prerelease
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * Resolve health for one provider. `resolveExe` is injected so tests can drive
 * detection without depending on what happens to be installed on the machine.
 */
export async function providerHealth(
  name: ProviderName,
  resolveExe: () => string,
  detect: (exe: string) => Promise<string | null> = runVersion,
): Promise<ProviderHealth> {
  const verifiedAgainst = VERIFIED_AGAINST[name];
  const capabilities = capabilitiesFor(name);

  let exe: string;
  try {
    exe = resolveExe();
  } catch {
    return {
      name,
      available: false,
      version: null,
      verifiedAgainst,
      capabilities,
      warnings: [
        {
          code: "provider_not_found",
          message: `${name} could not be located. Sessions for this provider cannot start.`,
        },
      ],
    };
  }

  const version = await detect(exe);
  // A version we cannot read does not prove the CLI is missing — resolveExe
  // found it. Report it available and flag the compatibility unknown.
  const warning = compareToVerified(version, verifiedAgainst);

  return {
    name,
    available: true,
    version,
    verifiedAgainst,
    capabilities,
    warnings: warning ? [warning] : [],
  };
}
