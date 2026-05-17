import semver from "semver";
import type { UpdateConfig } from "../schemas/updateConfig.schema";
import { fetchLatestRelease, fetchReleaseByTag, type ReleaseInfo } from "./github-releases";

export interface CheckResult {
  current: string;
  latest: string | null;
  diff: semver.ReleaseType | null;
  wouldInstall: boolean;
  reason: string;
}

export interface CheckOptions {
  currentVersion: string;
  config: UpdateConfig;
  pinnedVersion?: string;
  allowMajor?: boolean;
}

/**
 * Strips tsup's build-metadata suffix ("+abc1234-dirty") from a version
 * string before passing it to semver. semver tolerates build metadata in
 * a few APIs but coerce gives us a clean baseline.
 */
function normalizeVersion(raw: string): string {
  const stripped = raw.split("+")[0];
  const coerced = semver.coerce(stripped);
  if (!coerced) throw new Error(`Cannot parse version: ${raw}`);
  return coerced.version;
}

export async function checkForUpdate(opts: CheckOptions): Promise<CheckResult> {
  const current = normalizeVersion(opts.currentVersion);

  const target: ReleaseInfo | null = opts.pinnedVersion
    ? await fetchReleaseByTag(opts.config.github_repo, opts.pinnedVersion)
    : await fetchLatestRelease(opts.config.github_repo, opts.config.channel);

  if (!target) {
    return {
      current,
      latest: null,
      diff: null,
      wouldInstall: false,
      reason: opts.pinnedVersion
        ? `No release found for tag ${opts.pinnedVersion}`
        : `No ${opts.config.channel} release found for ${opts.config.github_repo}`,
    };
  }

  const latest = normalizeVersion(target.version);

  if (semver.eq(current, latest)) {
    return { current, latest, diff: null, wouldInstall: false, reason: "Already up to date" };
  }

  if (semver.lt(latest, current)) {
    return {
      current,
      latest,
      diff: null,
      wouldInstall: false,
      reason: `Current version ${current} is newer than ${opts.config.channel} (${latest})`,
    };
  }

  const diff = semver.diff(current, latest);
  if (!diff) {
    return { current, latest, diff: null, wouldInstall: false, reason: "No semver diff" };
  }

  if (diff === "major" && !opts.allowMajor) {
    return {
      current,
      latest,
      diff,
      wouldInstall: false,
      reason: `Major bump (${current} → ${latest}). Re-run with --allow-major to install.`,
    };
  }

  const allowList = opts.config.allow;
  const allowed =
    diff === "patch"
      ? allowList.includes("patch")
      : diff === "minor"
        ? allowList.includes("minor")
        : diff === "major"
          ? allowList.includes("major") || Boolean(opts.allowMajor)
          : false;

  if (!allowed) {
    return {
      current,
      latest,
      diff,
      wouldInstall: false,
      reason: `Diff '${diff}' not in allow list [${allowList.join(", ")}]`,
    };
  }

  return {
    current,
    latest,
    diff,
    wouldInstall: true,
    reason: `Would install ${current} → ${latest} (${diff})`,
  };
}
