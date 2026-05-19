#!/usr/bin/env node
// Walks release-artifacts/, hashes each tarball, and writes manifest.json
// that the streamer's updater consumes.
//
// Tarball filename convention (set by pack-platform.mjs):
//   threadbase-streamer-{version}-{os}-{arch}.tgz
//
// Usage: node scripts/build-manifest.mjs [--dir <release-artifacts>] [--version <x.y.z>]

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
const verIdx = args.indexOf("--version");
const dir = resolve(dirIdx >= 0 ? args[dirIdx + 1] : "release-artifacts");
const pinnedVersion = verIdx >= 0 ? args[verIdx + 1] : null;

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const version = pinnedVersion ?? pkg.version;

const TARBALL_RE = new RegExp(
  `^threadbase-streamer-${version.replace(/\./g, "\\.")}-([^-]+)-([^.]+)\\.tgz$`,
);

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((res, rej) => {
    createReadStream(filePath).on("data", (chunk) => hash.update(chunk)).on("end", res).on("error", rej);
  });
  return hash.digest("hex");
}

const artifacts = {};
const files = readdirSync(dir).filter((f) => f.endsWith(".tgz"));

for (const filename of files) {
  const match = filename.match(TARBALL_RE);
  if (!match) {
    console.warn(`skip ${filename} — does not match version ${version}`);
    continue;
  }
  const [, os, arch] = match;
  const filePath = join(dir, filename);
  const sum = await sha256(filePath);
  const { size } = statSync(filePath);
  artifacts[`${os}-${arch}`] = { filename, sha256: sum, size };
  console.log(`  ${os}-${arch}: ${sum.slice(0, 12)}… (${size} bytes)`);
}

if (Object.keys(artifacts).length === 0) {
  console.error(`No matching tarballs found in ${dir} for version ${version}`);
  process.exit(1);
}

const manifest = {
  version,
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  artifacts,
};

const outPath = join(dir, "manifest.json");
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}`);
