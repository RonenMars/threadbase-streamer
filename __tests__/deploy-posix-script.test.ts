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
});
