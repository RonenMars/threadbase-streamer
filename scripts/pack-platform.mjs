#!/usr/bin/env node
// Packages dist/ + package metadata + node_modules/node-pty into a single
// platform-specific tarball. Run after `npm run build` on each matrix runner.
// Usage: node scripts/pack-platform.mjs [--out <dir>]

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { arch as nodeArch, platform as nodePlatform } from "node:os";
import { join, resolve } from "node:path";
import { create as tarCreate } from "tar";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "release-artifacts");

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const version = pkg.version;
const target = `${nodePlatform()}-${nodeArch()}`;
const filename = `threadbase-streamer-${version}-${target}.tgz`;
const outPath = join(outDir, filename);

mkdirSync(outDir, { recursive: true });
if (existsSync(outPath)) rmSync(outPath);

// node-pty and better-sqlite3 are tsup-external in dist/cli.cjs (see
// tsup.config.ts), so the prebuilt native binaries for the current arch
// must travel inside the tarball. node-pty's spawn-helper bit is fixed by
// the package.json postinstall at deploy time; better-sqlite3's prebuild
// lives under node_modules/better-sqlite3/build/Release.
const entries = [
  "dist",
  "package.json",
  "package-lock.json",
  "node_modules/node-pty",
  "node_modules/better-sqlite3",
];

for (const entry of entries) {
  if (!existsSync(entry)) {
    console.error(`pack-platform: required entry missing: ${entry}`);
    process.exit(1);
  }
}

await tarCreate({ gzip: true, file: outPath, cwd: process.cwd() }, entries);

const { size } = statSync(outPath);
console.log(`packed ${filename} (${size} bytes)`);
console.log(outPath);
