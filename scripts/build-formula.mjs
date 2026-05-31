#!/usr/bin/env node
// Renders scripts/templates/tb-streamer.rb.tmpl into a real formula file.
// Usage: node scripts/build-formula.mjs --version <ver> --artifacts <dir> --out <file>

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function arg(name, required = true) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx === process.argv.length - 1) {
    if (required) {
      console.error(`Missing --${name}`);
      process.exit(2);
    }
    return undefined;
  }
  return process.argv[idx + 1];
}

const version = arg("version");
const artifacts = resolve(arg("artifacts"));
const out = resolve(arg("out"));
const templatePath = join(__dirname, "templates", "tb-streamer.rb.tmpl");

const targets = [
  { key: "DARWIN_ARM64", file: `threadbase-streamer-${version}-darwin-arm64.tgz` },
  { key: "DARWIN_X64", file: `threadbase-streamer-${version}-darwin-x64.tgz` },
  { key: "LINUX_X64", file: `threadbase-streamer-${version}-linux-x64.tgz` },
];

const replacements = { VERSION: version };

for (const { key, file } of targets) {
  const path = join(artifacts, file);
  if (!existsSync(path)) {
    console.error(`Missing artifact: ${path}`);
    process.exit(1);
  }
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  replacements[`SHA256_${key}`] = sha;
}

let rendered = readFileSync(templatePath, "utf-8");
for (const [k, v] of Object.entries(replacements)) {
  rendered = rendered.replaceAll(`{{${k}}}`, v);
}

const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/g);
if (unresolved) {
  console.error("Template still contains unresolved placeholders after render:");
  console.error(unresolved);
  process.exit(1);
}

writeFileSync(out, rendered, "utf-8");
console.log(`wrote ${out}`);
