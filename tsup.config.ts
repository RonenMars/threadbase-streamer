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
const dirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
const version = `${pkg.version}+${sha}${dirty ? "-dirty" : ""}`;

// src/db/migrations.ts and src/db/sqlite-migrate.ts use `import.meta.url` guarded
// by a runtime `if (import.meta.url)` / `if (typeof import.meta !== "undefined")`
// check so the same source works in both ESM and CJS bundles. esbuild can't
// statically prove the guard is safe and emits `empty-import-meta` warnings for
// every site in the CJS build (the branch is dead code at runtime — CJS falls
// through to `__dirname`). Silence those warnings here rather than restructure
// the source — the runtime behaviour is correct and tested.
const silenceImportMetaWarning = (options: { logOverride?: Record<string, string> }) => {
  options.logOverride = { ...(options.logOverride ?? {}), "empty-import-meta": "silent" };
};

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
    esbuildOptions: silenceImportMetaWarning,
  },
  {
    entry: { cli: "cli/index.ts", "launchd-entry": "cli/launchd-entry.ts" },
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    outDir: "dist",
    external: ["node-pty", "better-sqlite3"],
    noExternal: [/^(?!node-pty|better-sqlite3).*/],
    splitting: false,
    outExtension: () => ({ js: ".cjs" }),
    define: { __VERSION__: JSON.stringify(version) },
    esbuildOptions: silenceImportMetaWarning,
  },
]);
