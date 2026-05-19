import { homedir } from "node:os";
import { join } from "node:path";

export const THREADBASE_ROOT = join(homedir(), ".threadbase");
export const RELEASES_DIR = join(THREADBASE_ROOT, "releases");
export const CURRENT_SYMLINK = join(THREADBASE_ROOT, "current");
export const DOWNLOAD_DIR = join(THREADBASE_ROOT, "releases", ".tmp");

export function releaseDir(version: string): string {
  return join(RELEASES_DIR, version);
}

export function downloadPath(version: string, filename: string): string {
  return join(DOWNLOAD_DIR, `${version}-${filename}`);
}
