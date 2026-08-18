import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * npm 12 blocks dependency install scripts unless `allowScripts` names the
 * package. Whether that blocking helps or hurts depends entirely on whether the
 * package ships a prebuilt binary, so the entries here are deliberately
 * asymmetric and the asymmetry is the point.
 *
 * `node-pty` publishes prebuilds for darwin-{arm64,x64} and win32-{arm64,x64}
 * and **nothing for Linux**, so on the Cloud VM it genuinely has to compile.
 * Blocked there, the build fails *silently*: `npm install` exits 0, prints a
 * warning among many, and leaves no `.node` behind. The streamer then cannot
 * spawn a single session — every start fails at import — on a machine where
 * nothing about the install looked wrong. Observed 2026-08-12 on npm 12.0.2.
 *
 * `better-sqlite3` is the opposite case since v13, and allow-listing it is
 * actively harmful. It ships prebuilds for darwin, linux, linuxmusl and win32,
 * so it never needs to compile — and it declares no `install` script of its own,
 * which means npm *synthesises* `node-gyp rebuild` from the `binding.gyp` it
 * ships. Letting that run makes npm compile from source and ignore the binary
 * already in the tarball; on a machine with no C++ toolchain the install fails
 * outright. That is exactly what broke `Smoke (windows-latest)` with
 * `gyp ERR! find VS` until the CI job moved to `npm ci --ignore-scripts`.
 *
 * v12 got away with being listed because its explicit
 * `install: prebuild-install || node-gyp rebuild` overrode the implicit gyp and
 * downloaded a binary. v13 has nothing to override it.
 *
 * So the invariant is not "allow-list every native dependency". It is:
 * allow-list a native dependency **iff** it lacks a prebuild for a platform we
 * ship on. Both directions are asserted, because re-adding `better-sqlite3`
 * would look like tidying up an oversight and would break installs instead.
 */

/** Native deps with no prebuild for some platform we ship on — must be allowed. */
const MUST_ALLOW = ["node-pty"];

/** Native deps that ship prebuilds everywhere — allowing them forces a needless
 *  source build, and fails outright without a compiler. */
const MUST_NOT_ALLOW = ["better-sqlite3"];

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  allowScripts?: Record<string, boolean>;
};

describe("allowScripts is scoped to native deps that actually need to build", () => {
  it.each([...MUST_ALLOW, ...MUST_NOT_ALLOW])("%s is still a runtime dependency", (name) => {
    // Paired with the checks below so the two cannot drift: dropping the
    // dependency should drop its allowScripts entry, not orphan it.
    expect(Object.keys(pkg.dependencies)).toContain(name);
  });

  it.each(MUST_ALLOW)("%s is allow-listed so its build actually runs", (name) => {
    expect(pkg.allowScripts?.[name]).toBe(true);
  });

  it.each(MUST_NOT_ALLOW)("%s is NOT allow-listed — it ships prebuilds", (name) => {
    expect(pkg.allowScripts?.[name]).toBeUndefined();
  });
});
