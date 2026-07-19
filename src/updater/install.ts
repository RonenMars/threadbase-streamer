import { mkdirSync } from "node:fs";
import type { UpdateConfig } from "../schemas/updateConfig.schema";
import { countActiveSessions } from "./active-sessions";
import { isBrewInstall } from "./brew-detect";
import { checkForUpdate } from "./check-update";
import { downloadAndVerify, fetchManifest } from "./download";
import { fetchLatestRelease, fetchReleaseByTag } from "./github-releases";
import { pickArtifact } from "./manifest";
import { DOWNLOAD_DIR, downloadPath, releaseDir } from "./paths";
import { restartService, stopService } from "./restart";
import { waitForRestartHealth } from "./restart-health";
import { stampVersionTxt } from "./stamp-version";
import { ensureReleasesDir, pruneOldReleases, swapCurrent } from "./swap";
import { unpackTarball } from "./unpack";
import { appendUpdateLog } from "./update-log";

export interface InstallOptions {
  currentVersion: string;
  config: UpdateConfig;
  pinnedVersion?: string;
  allowMajor?: boolean;
  force?: boolean;
  dryRun?: boolean;
  /** Used to talk to the running streamer for the active-session defer check. */
  runningServer?: { port: number; apiKey: string };
}

export type InstallResult =
  | { kind: "no-op"; reason: string; current: string; latest: string | null }
  | { kind: "unsupported-install"; reason: string; current: string }
  | {
      kind: "deferred";
      reason: string;
      activeSessions: number;
      latest: string;
    }
  | {
      kind: "dry-run";
      latest: string;
      tarballUrl: string;
    }
  | {
      kind: "installed";
      previous: string;
      installed: string;
      pruned: string[];
      restart: { method: string };
    };

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  // A Homebrew install runs from the Cellar (libexec/), which this updater's
  // file-swap never touches — downloading would orphan the new release without
  // applying it. Refuse early and point at the supported path.
  if (isBrewInstall()) {
    const result = {
      kind: "unsupported-install" as const,
      reason: "Installed via Homebrew — run `brew upgrade tb-streamer` to update.",
      current: opts.currentVersion,
    };
    appendUpdateLog(`[no-op] ${result.reason}`);
    return result;
  }

  const check = await checkForUpdate({
    currentVersion: opts.currentVersion,
    config: opts.config,
    pinnedVersion: opts.pinnedVersion,
    allowMajor: opts.allowMajor,
  });

  appendUpdateLog(
    `[check] current=${check.current} latest=${check.latest ?? "none"} status=${check.reason}`,
  );

  if (!check.wouldInstall) {
    return { kind: "no-op", reason: check.reason, current: check.current, latest: check.latest };
  }

  const target = opts.pinnedVersion
    ? await fetchReleaseByTag(opts.config.github_repo, opts.pinnedVersion)
    : await fetchLatestRelease(opts.config.github_repo, opts.config.channel);

  if (!target) {
    return {
      kind: "no-op",
      reason: "Release vanished between check and install",
      current: check.current,
      latest: check.latest,
    };
  }

  const targetVersion = check.latest;
  if (!targetVersion) {
    return {
      kind: "no-op",
      reason: "checkForUpdate returned no latest version",
      current: check.current,
      latest: null,
    };
  }

  const manifest = await fetchManifest(target.assets);
  const artifact = pickArtifact(manifest);

  if (opts.dryRun) {
    const asset = target.assets.find((a) => a.name === artifact.filename);
    const tarballUrl = asset?.browserDownloadUrl ?? "(missing)";
    appendUpdateLog(
      `[dry-run] would install ${check.current} → ${targetVersion} from ${tarballUrl}`,
    );
    return { kind: "dry-run", latest: targetVersion, tarballUrl };
  }

  if (opts.config.defer_if_active_sessions && !opts.force && opts.runningServer) {
    const active = await countActiveSessions(opts.runningServer);
    if (active.kind === "count" && active.count > 0) {
      const reason = `${active.count} active session(s); use --force to interrupt`;
      appendUpdateLog(`[deferred] ${check.current} → ${targetVersion}: ${reason}`);
      return { kind: "deferred", reason, activeSessions: active.count, latest: targetVersion };
    }
    if (active.kind === "error") {
      // Streamer is reachable but its state is unknown — defer rather than
      // risk killing live sessions we couldn't see.
      const reason = `cannot determine active sessions (${active.reason}); use --force to override`;
      appendUpdateLog(`[deferred] ${check.current} → ${targetVersion}: ${reason}`);
      return { kind: "deferred", reason, activeSessions: -1, latest: targetVersion };
    }
    // active.kind === "unreachable" → streamer is down, nothing to interrupt.
  }

  ensureReleasesDir();
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const tarballPath = downloadPath(targetVersion, artifact.filename);
  await downloadAndVerify({ manifest, assets: target.assets, targetPath: tarballPath });

  const destDir = releaseDir(targetVersion);
  await unpackTarball({ tarballPath, destDir });
  stampVersionTxt(destDir, targetVersion);

  // On Windows the streamer process holds open handles inside
  // ~/.threadbase/current/, which makes the directory replace inside
  // swapCurrent fail with EBUSY. Stop the service first; restartService
  // below will bring it back on the new version. macOS/Linux swap via
  // atomic symlink rename and don't need this — stopService is a no-op
  // there.
  if (process.platform === "win32") {
    await stopService({ port: opts.runningServer?.port }).catch(() => {
      /* best effort — swap may still succeed if the streamer wasn't running */
    });
  }

  swapCurrent(targetVersion);

  const pruned = pruneOldReleases(targetVersion);

  let restartMethod = "skipped";
  try {
    const r = await restartService();
    restartMethod = r.method;
    if (opts.runningServer && r.method !== "none") {
      await waitForRestartHealth({
        port: opts.runningServer.port,
        expectedVersion: targetVersion,
      });
    }
  } catch (err) {
    // The release is on disk, but a command success is not enough: the process
    // serving /healthz must report the target version. Surface failure loudly
    // while leaving the new release ready for the next successful service start.
    restartMethod = `failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const installed = {
    kind: "installed" as const,
    previous: check.current,
    installed: targetVersion,
    pruned,
    restart: { method: restartMethod },
  };
  const outcome = restartMethod.startsWith("failed:") ? "failed" : "installed";
  appendUpdateLog(
    `[${outcome}] ${installed.previous} → ${installed.installed} restart=${installed.restart.method}${pruned.length > 0 ? ` pruned=${pruned.length}` : ""}`,
  );
  return installed;
}
