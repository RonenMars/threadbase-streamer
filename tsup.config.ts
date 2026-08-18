import { defineConfig } from "tsup";

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
    // TypeScript 7's native compiler no longer exposes the JS Compiler API
    // (`ts.sys`), which tsup 8.5's bundled rollup-plugin-dts@6.1.1 reads.
    // Declarations come from `tsc -p tsconfig.build.json` in the build script.
    dts: false,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    external: ["node-pty", "pg"],
    esbuildOptions: silenceImportMetaWarning,
  },
  {
    entry: {
      cli: "cli/index.ts",
      "launchd-entry": "cli/launchd-entry.ts",
      "seed-claude-config": "src/docker/seed-claude-config.ts",
      "merge-server-yaml": "src/docker/mergeServerYaml.ts",
      "ensure-demo-project-dirs": "src/docker/ensureDemoProjectDirs.ts",
    },
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    outDir: "dist",
    external: ["node-pty", "better-sqlite3"],
    noExternal: [/^(?!node-pty|better-sqlite3).*/],
    splitting: false,
    outExtension: () => ({ js: ".cjs" }),
    esbuildOptions: silenceImportMetaWarning,
  },
]);
