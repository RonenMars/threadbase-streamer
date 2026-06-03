import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Stamps the runtime version next to the unpacked dist/cli.cjs so
// getVersion() reports the freshly installed version (not whatever
// package.json shipped inside the tarball, which is frozen at the previous
// release because semantic-release bumps the version after the build matrix
// has packed the tarballs).
//
// Kept in its own module so __tests__/install.test.ts can mock the side
// effect via vi.mock rather than wrestling with stubbing fs.writeFileSync.
export function stampVersionTxt(destDir: string, version: string): void {
  const distDir = join(destDir, "dist");
  // mkdirSync handles the (defensive) case where the tarball didn't include
  // a dist/ tree — shouldn't happen in practice, but cheaper than crashing.
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "version.txt"), `${version}+update\n`);
}
