import { mkdirSync } from "node:fs";
import type { UpdateConfig } from "../schemas/updateConfig.schema";
import { countActiveSessions } from "./active-sessions";
import { checkForUpdate } from "./check-update";
import { downloadAndVerify, fetchManifest } from "./download";
import { fetchLatestRelease, fetchReleaseByTag } from "./github-releases";
import { pickArtifact } from "./manifest";
import { DOWNLOAD_DIR, downloadPath, releaseDir } from "./paths";
import { restartService, stopService } from "./restart";
import { ensureReleasesDir, pruneOldReleases, swapCurrent } from "./swap";
import { unpackTarball } from "./unpack";

export interface InstallOptions {
  currentVersion: string;
  config: UpdateConfig;
  pinnedVersion?: string;
  allowMajor?: boolean;
  force?: boolean;
  dryRun?: boolean;
  /** Used to talk to the running streamer for the active-session defer check. */
  runningServer?: { port: number; apiKey: string };
  /** Override the platform restart for tests. */
  restart?: () => Promise<void>;
}

export type InstallResult =
  | { kind: "no-op"; reason: string; current: string; latest: string | null }
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
  const check = await checkForUpdate({
    currentVersion: opts.currentVersion,
    config: opts.config,
    pinnedVersion: opts.pinnedVersion,
    allowMajor: opts.allowMajor,
  });

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
    return {
      kind: "dry-run",
      latest: targetVersion,
      tarballUrl: asset?.browserDownloadUrl ?? "(missing)",
    };
  }

  if (opts.config.defer_if_active_sessions && !opts.force && opts.runningServer) {
    const active = await countActiveSessions(opts.runningServer);
    if (active > 0) {
      return {
        kind: "deferred",
        reason: `${active} active session(s); use --force to interrupt`,
        activeSessions: active,
        latest: targetVersion,
      };
    }
  }

  ensureReleasesDir();
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const tarballPath = downloadPath(targetVersion, artifact.filename);
  await downloadAndVerify({ manifest, assets: target.assets, targetPath: tarballPath });

  const destDir = releaseDir(targetVersion);
  await unpackTarball({ tarballPath, destDir });

  // On Windows the streamer process holds open handles inside
  // ~/.threadbase/current/, which makes the directory replace inside
  // swapCurrent fail with EBUSY. Stop the service first; restartService
  // below will bring it back on the new version. macOS/Linux swap via
  // atomic symlink rename and don't need this — stopService is a no-op
  // there.
  if (process.platform === "win32") {
    await stopService().catch(() => {
      /* best effort — swap may still succeed if the streamer wasn't running */
    });
  }

  swapCurrent(targetVersion);

  const pruned = pruneOldReleases(targetVersion);

  let restartMethod = "skipped";
  try {
    if (opts.restart) {
      await opts.restart();
      restartMethod = "custom";
    } else {
      const r = await restartService();
      restartMethod = r.method;
    }
  } catch (err) {
    // Restart failure is recoverable — log via return value rather than throw.
    // The new release is on disk and `current` is repointed; next service
    // start picks it up.
    restartMethod = `failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    kind: "installed",
    previous: check.current,
    installed: targetVersion,
    pruned,
    restart: { method: restartMethod },
  };
}
