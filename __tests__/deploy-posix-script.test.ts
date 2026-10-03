import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const deployScript = readFileSync(resolve(import.meta.dirname, "../scripts/deploy.sh"), "utf8");

describe("POSIX deploy script", () => {
  // `cp -r src dst` copies the source INTO dst when dst already exists, so an
  // unguarded copy nested another copy at dst/$mod/$mod on every deploy after
  // the first. deploy.ps1 had the same defect for node-pty; this loop covers
  // all four native modules at once, so it could nest four of them.
  const nativeCopyLoop = (() => {
    const start = deployScript.indexOf("for mod in node-pty better-sqlite3");
    expect(start).toBeGreaterThan(-1);
    const end = deployScript.indexOf("done", start);
    expect(end).toBeGreaterThan(start);
    return deployScript.slice(start, end);
  })();

  it("clears each native module's destination before copying into it", () => {
    expect(nativeCopyLoop).toContain('rm -rf "$RELEASES_DIR/node_modules/$mod"');
  });

  it("removes before it copies, not after", () => {
    const remove = nativeCopyLoop.indexOf('rm -rf "$RELEASES_DIR/node_modules/$mod"');
    const copy = nativeCopyLoop.indexOf('cp -r "node_modules/$mod"');
    expect(remove).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(-1);
    expect(remove).toBeLessThan(copy);
  });

  describe("menubar update", () => {
    const menubarUpdate = (() => {
      const start = deployScript.indexOf("ensure_menubar_current() {");
      expect(start).toBeGreaterThan(-1);
      const end = deployScript.indexOf("\n}\n", start);
      expect(end).toBeGreaterThan(start);
      return deployScript.slice(start, end);
    })();

    // A `git pull` that bumps the pointer leaves the submodule checkout at the
    // old commit, so the checkout's package.json names the version already
    // installed and the update would never fire.
    it("reads the pinned version from the recorded pointer, not the checkout", () => {
      expect(menubarUpdate).toContain("rev-parse -q --verify HEAD:vendor/menubar");
      expect(menubarUpdate).toContain('show "$sha:package.json"');
      expect(menubarUpdate).not.toContain('"$sub/package.json"');
    });

    it("only installs a strictly newer version", () => {
      expect(menubarUpdate).toContain("semver.gt(process.argv[1], process.argv[2])");
      expect(menubarUpdate).toContain('"$pinned" "$installed"');
    });

    it("verifies the download before quitting the app, and quits before replacing it", () => {
      const verify = menubarUpdate.indexOf("codesign --verify --deep --strict");
      const gatekeeper = menubarUpdate.indexOf("spctl -a");
      const quit = menubarUpdate.indexOf("to quit");
      const replace = menubarUpdate.indexOf('mv "$target" "$previous"');
      expect(verify).toBeGreaterThan(-1);
      expect(gatekeeper).toBeGreaterThan(verify);
      expect(quit).toBeGreaterThan(gatekeeper);
      expect(replace).toBeGreaterThan(quit);
    });

    it("runs after the healthcheck and cannot fail the deploy", () => {
      const deploy = deployScript.slice(deployScript.indexOf("cmd_deploy() {"));
      const healthcheck = deploy.indexOf("cmd_kickstart_and_healthcheck");
      const call = deploy.indexOf("ensure_menubar_current || warn");
      expect(healthcheck).toBeGreaterThan(-1);
      expect(call).toBeGreaterThan(healthcheck);
    });
  });

  it("sets launchd NumberOfFiles to 65536 and heals the previous 16384 cap", () => {
    expect(deployScript).toMatch(/<key>NumberOfFiles<\/key>\s*<integer>65536<\/integer>/);
    expect(deployScript).toContain("plist SoftResourceLimits is still 16384 — rewriting to 65536");
  });
});
