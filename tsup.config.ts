import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    external: ["node-pty"],
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
    outExtension: () => ({ js: ".js" }),
  },
]);
