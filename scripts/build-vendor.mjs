#!/usr/bin/env node
// Install (and optionally build) a vendored submodule, skipping the work when
// the submodule's committed SHA is unchanged since the last successful run.
//
// The two vendored submodules (vendor/scanner, vendor/agent-types) are wired as
// `file:` deps and rebuilt by the root `postinstall`. Their `npm install` only
// needs to re-run when the submodule pointer actually moves — otherwise every
// `npm install` in this repo pays ~2.4s re-installing dependencies that are
// already present and correct. We stamp the submodule's HEAD SHA after a
// successful run and skip on the next run when the SHA, node_modules, and any
// build output are all still in place.
//
// Both submodules' consumers import their `dist/` output (scanner builds it via
// its own `prepare` script during install; agent-types needs an explicit
// `--build`). Either way we verify `dist/` is present before skipping, so a
// deleted build forces a rebuild even when node_modules survived.
//
// Usage:
//   node scripts/build-vendor.mjs <dir> [--build]
//     <dir>     path to the submodule (e.g. vendor/scanner)
//     --build   also run `npm run build` in the submodule after install
//
// If the SHA can't be read (e.g. installing from a tarball with no .git), we
// always run — never skip on uncertainty.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.argv[2];
const doBuild = process.argv.includes("--build");

if (!dir) {
  console.error("build-vendor: missing submodule directory argument");
  process.exit(1);
}

// Stamp lives in the parent repo (not inside the submodule) so a successful run
// never dirties the submodule's working tree. .vendor-stamps/ is gitignored.
const stampDir = ".vendor-stamps";
const stampPath = join(stampDir, `${basename(dir)}.sha`);
const nodeModules = join(dir, "node_modules");
const distDir = join(dir, "dist");

function npm(args) {
  // npm.cmd on Windows; npm everywhere else. Resolve the binary name directly
  // instead of using shell:true (which Node flags as a security risk and which
  // would require escaping the args).
  const bin = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(bin, args, { cwd: dir, stdio: "inherit" });
}

function currentSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  } catch {
    return null; // no git / not a checkout — treat as "unknown", never skip
  }
}

const sha = currentSha();
const haveDeps = existsSync(nodeModules);
const haveBuild = existsSync(distDir);
const stamped = existsSync(stampPath)
  ? readFileSync(stampPath, "utf8").trim()
  : null;

if (sha && stamped === sha && haveDeps && haveBuild) {
  console.log(`build-vendor: ${dir} up to date (${sha.slice(0, 8)}), skipping`);
  process.exit(0);
}

npm(["install", "--no-audit", "--no-fund"]);
if (doBuild) {
  // Drop a stale incremental-build cache before building. tsc treats a present
  // tsconfig.tsbuildinfo as "already emitted" and writes no dist/ — so if dist
  // was deleted (the case that brought us here) while the buildinfo survived,
  // the build would silently produce nothing. Removing it forces a full emit.
  rmSync(join(dir, "tsconfig.tsbuildinfo"), { force: true });
  npm(["run", "build"]);
}

// Stamp only after the work succeeded (execFileSync throws on failure, which
// aborts before we get here). Skip stamping when the SHA is unknown so the next
// run re-evaluates instead of trusting a stamp we can't tie to a commit.
if (sha) {
  mkdirSync(stampDir, { recursive: true });
  writeFileSync(stampPath, `${sha}\n`);
}
