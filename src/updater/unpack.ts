import { mkdirSync, rmSync } from "node:fs";
import { extract as tarExtract } from "tar";

/**
 * Extracts a tarball into `destDir`. Wipes `destDir` first to ensure a clean
 * install — callers must ensure the streamer process is not reading from it.
 */
export async function unpackTarball(opts: { tarballPath: string; destDir: string }): Promise<void> {
  const { tarballPath, destDir } = opts;
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  await tarExtract({ file: tarballPath, cwd: destDir });
}
