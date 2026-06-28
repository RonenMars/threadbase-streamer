import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { CURRENT_SYMLINK, RELEASES_DIR, THREADBASE_ROOT, releaseDir } from "./paths";

const KEEP_LAST_N = 2;

/**
 * Repoints ~/.threadbase/current at the new release directory.
 *
 * macOS/Linux: atomic symlink swap via rename(2).
 * Windows: no reliable symlinks without admin — copy the release dir into
 * `current/` as a plain folder. This mirrors what the existing Windows
 * deploy script does today.
 */
export function swapCurrent(version: string): void {
  const target = releaseDir(version);
  if (!existsSync(target)) {
    throw new Error(`Cannot swap to ${version}: ${target} does not exist`);
  }

  if (process.platform === "win32") {
    // Treat CURRENT_SYMLINK as a directory we replace wholesale.
    const tmp = `${CURRENT_SYMLINK}.new`;
    rmSync(tmp, { recursive: true, force: true });
    cpSync(target, tmp, { recursive: true });
    if (existsSync(CURRENT_SYMLINK)) {
      rmSync(CURRENT_SYMLINK, { recursive: true, force: true });
    }
    renameSync(tmp, CURRENT_SYMLINK);
    // Keep cli.js in sync so launch.cmd always points to the same entry
    // point regardless of whether the update came from the deploy script
    // (which writes cli.js directly) or the auto-updater (which writes
    // current/ and must mirror it here).
    copyFileSync(join(CURRENT_SYMLINK, "dist", "cli.cjs"), join(THREADBASE_ROOT, "cli.js"));
    return;
  }

  const tmpLink = `${CURRENT_SYMLINK}.new`;
  if (existsSync(tmpLink) || lstatSafeIsSymlink(tmpLink)) {
    unlinkSync(tmpLink);
  }
  symlinkSync(target, tmpLink);
  renameSync(tmpLink, CURRENT_SYMLINK);

  // Keep cli.js in sync so the launchd/systemd entry point always resolves
  // to the new release, regardless of whether the update came from the deploy
  // script (which writes cli.js directly) or the auto-updater (which only
  // swaps current/ and must mirror it here).
  const cliJs = join(THREADBASE_ROOT, "cli.js");
  const tmpCliJs = `${cliJs}.new`;
  if (existsSync(tmpCliJs) || lstatSafeIsSymlink(tmpCliJs)) unlinkSync(tmpCliJs);
  symlinkSync(join(target, "dist", "cli.cjs"), tmpCliJs);
  renameSync(tmpCliJs, cliJs);
}

function lstatSafeIsSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Removes release directories beyond the most recent N (by semver), keeping
 * the currently-active one even if it would otherwise be pruned.
 */
export function pruneOldReleases(activeVersion: string, keep: number = KEEP_LAST_N): string[] {
  if (!existsSync(RELEASES_DIR)) return [];

  const entries = readdirSync(RELEASES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => semver.valid(name) !== null);

  const sorted = entries.sort((a, b) => semver.rcompare(a, b));
  const toKeep = new Set<string>(sorted.slice(0, keep));
  toKeep.add(activeVersion);

  const removed: string[] = [];
  for (const name of sorted) {
    if (toKeep.has(name)) continue;
    rmSync(releaseDir(name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export function ensureReleasesDir(): void {
  mkdirSync(RELEASES_DIR, { recursive: true });
}
