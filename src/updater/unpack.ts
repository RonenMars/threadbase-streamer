import { mkdirSync, rmSync } from "node:fs";
import { extract as tarExtract } from "tar";

/**
 * Extracts a tarball into `destDir`. Existing release directories are immutable;
 * refuse before extraction rather than overwrite files a process may be using.
 */
export async function unpackTarball(opts: { tarballPath: string; destDir: string }): Promise<void> {
  const { tarballPath, destDir } = opts;
  try {
    mkdirSync(destDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Release directory already exists; refusing to overwrite it");
    }
    throw error;
  }
  try {
    await tarExtract({ file: tarballPath, cwd: destDir });
  } catch (error) {
    // This directory was created by this attempt, never an installed release.
    rmSync(destDir, { recursive: true, force: true });
    throw error;
  }
}
