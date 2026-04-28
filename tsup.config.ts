import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const sha = git("rev-parse", "--short", "HEAD") || "unknown";
const dirty = git("status", "--porcelain").length > 0;
const version = `${pkg.version}+${sha}${dirty ? "-dirty" : ""}`;

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    external: ["node-pty", "pg"],
    define: { __VERSION__: JSON.stringify(version) },
  },
  {
    entry: { cli: "cli/index.ts" },
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    outDir: "dist",
    external: ["node-pty"],
    noExternal: [/^(?!node-pty).*/],
    splitting: false,
    outExtension: () => ({ js: ".cjs" }),
    define: { __VERSION__: JSON.stringify(version) },
  },
]);
