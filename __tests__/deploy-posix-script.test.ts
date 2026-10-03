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
      // "\n}" rather than "\n}\n": a Windows checkout has CRLF line endings.
      const end = deployScript.indexOf("\n}", start);
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
      const team = menubarUpdate.indexOf('[[ "$(menubar_team_id "$src")" != "$team" ]]');
      const quit = menubarUpdate.indexOf("to quit");
      const replace = menubarUpdate.indexOf('mv "$target" "$previous"');
      expect(verify).toBeGreaterThan(-1);
      expect(gatekeeper).toBeGreaterThan(verify);
      // Gatekeeper alone accepts any notarized developer; the team must match
      // the app already installed.
      expect(team).toBeGreaterThan(gatekeeper);
      expect(quit).toBeGreaterThan(team);
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

  describe("menubar submodule sync", () => {
    // A `git pull` that bumps the pointer leaves the checkout behind it, which
    // git reports as a modified tree: the deploy refused it as dirty, or under
    // --force stamped the release `-dirty`.
    it("syncs the checkout before the dirty-tree check reads it", () => {
      const check = deployScript.slice(deployScript.indexOf("cmd_predeploy_check() {"));
      const sync = check.indexOf("sync_menubar_submodule || true");
      const dirty = check.indexOf("git diff --name-only HEAD");
      expect(sync).toBeGreaterThan(-1);
      expect(dirty).toBeGreaterThan(sync);
    });

    // `git submodule update` on a checkout someone is working in moves their
    // HEAD off their commits, so only a clean, strictly-behind checkout moves.
    it("moves only a clean checkout that is behind the pinned commit", () => {
      const start = deployScript.indexOf("sync_menubar_submodule() {");
      const sync = deployScript.slice(start, deployScript.indexOf("\n}", start));
      const clean = sync.indexOf('[[ -z "$(git -C "$sub" status --porcelain');
      const behind = sync.indexOf('merge-base --is-ancestor "$head" "$pinned"');
      const update = sync.indexOf("submodule update --init vendor/menubar");
      expect(clean).toBeGreaterThan(-1);
      expect(behind).toBeGreaterThan(clean);
      expect(update).toBeGreaterThan(behind);
    });
  });

  it("sets launchd NumberOfFiles to 65536 and heals the previous 16384 cap", () => {
    expect(deployScript).toMatch(/<key>NumberOfFiles<\/key>\s*<integer>65536<\/integer>/);
    expect(deployScript).toContain("plist SoftResourceLimits is still 16384 — rewriting to 65536");
  });
});
