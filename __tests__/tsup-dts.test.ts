import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * tsup 8.5 bundles rollup-plugin-dts@6.1.1, which reads `ts.sys` from the
 * typescript package. TypeScript 7's native compiler does not expose that
 * API, so `dts: true` crashes the build with
 * `Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')`.
 * Declarations are emitted by `tsc -p tsconfig.build.json` instead.
 * Re-enabling tsup dts would fail CI on typescript@7 (PR #223).
 */
const ROOT = join(__dirname, "..");

describe("TypeScript 7 declaration emit", () => {
  it("does not ask tsup to generate .d.ts", () => {
    const cfg = readFileSync(join(ROOT, "tsup.config.ts"), "utf8");
    expect(cfg).toMatch(/dts:\s*false/);
    expect(cfg).not.toMatch(/dts:\s*true/);
  });

  it("emits declarations with tsc so dist/index.d.ts still ships", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: { build: string };
    };
    expect(pkg.scripts.build).toContain("tsc -p tsconfig.build.json");
  });
});
