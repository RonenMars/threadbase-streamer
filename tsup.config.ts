import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    external: ["node-pty", "pg"],
  },
  {
    entry: { cli: "cli/index.ts" },
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    outDir: "dist",
    external: ["node-pty", "pg"],
    noExternal: [/^(?!node-pty|pg).*/],
    splitting: false,
    outExtension: () => ({ js: ".cjs" }),
  },
]);
