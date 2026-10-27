import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("stages twice without changing the previous CLI, migrations or native dependency tree", () => {
  const root = resolve(import.meta.dirname, "..");
  const fixture = mkdtempSync(join(tmpdir(), "tb-stage-"));
  const install = join(fixture, "install");
  try {
    mkdirSync(join(fixture, "dist"));
    mkdirSync(install);
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(fixture, "dist", "launchd-entry.cjs"), "");
    for (const folder of ["migrations", "runtime-migrations", "pg-migrations"]) {
      mkdirSync(join(fixture, "dist", folder));
      writeFileSync(join(fixture, "dist", folder, "marker"), "original");
    }
    for (const mod of ["node-pty", "better-sqlite3", "bindings", "file-uri-to-path"]) {
      if (!existsSync(join(root, "node_modules", mod))) continue;
      cpSync(join(root, "node_modules", mod), join(fixture, "node_modules", mod), {
        recursive: true,
      });
    }
    const cli = (answer: number) =>
      `const D=require('better-sqlite3');const d=new D(':memory:');console.log(d.prepare('SELECT ${answer} AS answer').get().answer);d.close();`;
    for (const scriptName of ["deploy.sh", "deploy-linux.sh"]) {
      const script = readFileSync(join(root, "scripts", scriptName), "utf8");
      const deploy = script.slice(script.indexOf("cmd_deploy()"));
      const start = deploy.indexOf('  mkdir -p "$RELEASES_DIR"');
      const end = deploy.indexOf('  log "activating symlink"', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const stage = () => {
        const result = spawnSync(
          "bash",
          [
            "-c",
            `set -eu
log() { :; }
debug() { :; }
stage() {
  local sha=test
  local INSTALL_DIR="$TEST_INSTALL"
  local RELEASES_DIR="$TEST_INSTALL/releases"
  local REPO_ROOT="$TEST_REPO"
${deploy.slice(start, end)}
  printf '%s' "$release_dir"
}
stage`,
          ],
          {
            cwd: fixture,
            env: { ...process.env, TEST_INSTALL: install, TEST_REPO: fixture },
            encoding: "utf8",
          },
        );
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
      };
      writeFileSync(join(fixture, "dist", "cli.cjs"), cli(42));
      const first = stage();
      writeFileSync(join(fixture, "dist", "cli.cjs"), cli(43));
      const second = stage();
      expect(second).not.toBe(first);
      const run = spawnSync(process.execPath, [join(first, "cli.cjs")], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe("42");
      expect(readFileSync(join(first, "runtime-migrations", "marker"), "utf8")).toBe("original");
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
