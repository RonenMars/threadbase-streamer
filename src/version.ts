// Runtime version reporting.
//
// The version string is NOT baked into the compiled bundle. Each installer
// (Homebrew, auto-updater, scripts/deploy.sh) writes a `version.txt` next to
// the script it activates, so the binary reports the correct version even
// when the tarball it was built from carried a stale package.json.
//
// Resolution order:
//   1. Read `<dirname(process.argv[1])>/version.txt` — set by the installer.
//   2. Fall back to `<dirname(process.argv[1])>/../package.json` — covers
//      source-tree runs (vitest, ts-node, `npm run dev`) where no installer
//      has stamped a version.
//   3. If both fail, return "0.0.0+unknown" so callers never crash on a
//      missing version.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

let cached: string | undefined;

export function getVersion(): string {
  if (cached !== undefined) return cached;
  cached = resolveVersion();
  return cached;
}

// Exposed for tests to clear the memoization between cases.
export function resetVersionCache(): void {
  cached = undefined;
}

function resolveVersion(): string {
  const scriptPath = process.argv[1] ?? "";
  const here = scriptPath ? dirname(scriptPath) : process.cwd();
  try {
    const v = readFileSync(join(here, "version.txt"), "utf8").trim();
    if (v) return v;
  } catch {}
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    if (pkg.version) return `${pkg.version}+source`;
  } catch {}
  return "0.0.0+unknown";
}
