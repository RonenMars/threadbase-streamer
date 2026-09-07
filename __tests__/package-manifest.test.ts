import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// npm runs preinstall/install/postinstall on a CONSUMER's machine when they
// install this package. Anything those hooks invoke therefore has to be inside
// the published tarball — `files` is the whole tarball, there is no implicit
// inclusion for `scripts/`. Getting this wrong fails the install outright with
// MODULE_NOT_FOUND and npm rolls the whole thing back, so it is worth a test:
// `npm install -g @threadbase-sh/streamer` was broken this way from 2026-07-05
// (#176 added the preinstall) until #812, and nothing in the repo noticed
// because a dev checkout always has scripts/ on disk.
const ROOT = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const CONSUMER_HOOKS = ["preinstall", "install", "postinstall"] as const;

/** Paths the published `files` array covers — exact entry, or a directory prefix. */
const isPublished = (path: string): boolean =>
  (pkg.files as string[]).some((entry) => path === entry || path.startsWith(`${entry}/`));

describe("published manifest", () => {
  it("ships every scripts/ file its consumer-run lifecycle hooks invoke", () => {
    const referenced = CONSUMER_HOOKS.flatMap((hook) => {
      const body: string = pkg.scripts?.[hook] ?? "";
      return [...body.matchAll(/scripts\/[\w.-]+\.[cm]?js/g)].map((m) => m[0]);
    });

    for (const path of referenced) {
      expect(existsSync(join(ROOT, path)), `${path} is referenced but missing from the repo`).toBe(
        true,
      );
      expect(isPublished(path), `${path} runs on a consumer install but is not in "files"`).toBe(
        true,
      );
    }
  });

  it("still declares the preinstall guards this test exists to protect", () => {
    // A rename that drops the guards should update this test deliberately, not
    // pass by matching zero paths.
    expect(pkg.scripts.preinstall).toContain("scripts/check-node-version.mjs");
    expect(pkg.scripts.preinstall).toContain("scripts/check-native-abi.mjs");
  });
});
