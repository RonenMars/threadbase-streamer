import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Issue #900: one owner per machine. The deploy scripts remove the updater's
// staging trees (current/, releases/<semver>/, releases/.tmp/*.tgz) and keep
// two builds (active + rollback), except any build a live pty-host still runs.
// scripts/lib/prune-builds.sh is sourced by deploy.sh and deploy-linux.sh and is
// exercised here against temp install dirs only.
const root = resolve(import.meta.dirname, "..");
const lib = join(root, "scripts", "lib", "prune-builds.sh");
const posixOnly = process.platform === "win32" ? describe.skip : describe;

const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const touch = (path: string, ms: number) => utimesSync(path, ms / 1000, ms / 1000);

interface Fixture {
  dir: string;
  install: string;
  releases: string;
}

const fixtures: string[] = [];
const hosts: ChildProcess[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.kill("SIGKILL");
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An install dir shaped like a machine that has run both deploy.sh and the updater. */
function makeInstall(opts: { history?: [number, string][]; active?: string } = {}): Fixture {
  // realpath: macOS tmpdir is a symlink, and lsof prints physical paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tb-prune-")));
  fixtures.push(dir);
  const install = join(dir, "install");
  const releases = join(install, "releases");
  mkdirSync(releases, { recursive: true });
  const now = Date.now();
  // Oldest to newest: aaa, bbb, ccc, ddd (ddd is active).
  ["aaa", "bbb", "ccc", "ddd"].forEach((sha, i) => {
    const build = join(releases, `cli.${sha}.XXXXXX`);
    mkdirSync(join(build, "node_modules", "node-pty"), { recursive: true });
    writeFileSync(join(build, "cli.cjs"), `// ${sha}`);
    writeFileSync(join(build, "cli.cjs.version"), `1.0.0+${sha}\n`);
    writeFileSync(join(build, "node_modules", "node-pty", "pty.node"), "native");
    touch(build, now - (10 - i) * HOUR);
  });
  // A legacy flat artifact with its sidecar, older than all of the above.
  writeFileSync(join(releases, "cli.old1.cjs"), "// old1");
  writeFileSync(join(releases, "cli.old1.cjs.version"), "0.9.0+old1\n");
  touch(join(releases, "cli.old1.cjs"), now - 20 * HOUR);
  // The updater's trees.
  for (const v of ["1.90.1", "1.89.6"]) {
    mkdirSync(join(releases, v, "dist"), { recursive: true });
    mkdirSync(join(releases, v, "node_modules", "node-pty"), { recursive: true });
    writeFileSync(join(releases, v, "dist", "cli.cjs"), `// updater ${v}`);
    touch(join(releases, v), now - 30 * HOUR);
  }
  symlinkSync(join(releases, "1.90.1"), join(install, "current"));
  mkdirSync(join(releases, ".tmp"));
  writeFileSync(join(releases, ".tmp", "1.90.1-streamer.tgz"), "tarball");
  // Files that must never be touched.
  mkdirSync(join(install, "cache"));
  mkdirSync(join(install, "logs"));
  mkdirSync(join(install, "node_modules", "node-pty"), { recursive: true });
  for (const f of ["cache/cache.db", "runtime.db", "server.yaml", "logs/stdout.log", "update.yaml"])
    writeFileSync(join(install, f), "keep me");
  const active = opts.active ?? "cli.ddd.XXXXXX";
  symlinkSync(`releases/${active}/cli.cjs`, join(install, "cli.js"));
  const history = opts.history ?? [
    [now - 9 * HOUR, "releases/cli.aaa.XXXXXX/cli.cjs"],
    [now - 8 * HOUR, "releases/cli.bbb.XXXXXX/cli.cjs"],
    [now - 7 * HOUR, "releases/cli.ccc.XXXXXX/cli.cjs"],
    [now - 6 * HOUR, "releases/cli.ddd.XXXXXX/cli.cjs"],
  ];
  writeFileSync(
    join(releases, ".history"),
    `${history.map(([t, p]) => `${iso(t)} ${p}`).join("\n")}\n`,
  );
  return { dir, install, releases };
}

function prune(installArg: string, keep = 2) {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
log() { echo "LOG $*"; }; debug() { :; }; ok() { echo "OK $*"; }
warn() { echo "WARN $*" >&2; }; err() { echo "ERR $*" >&2; }
. "$LIB"
prune_builds "$1" ${keep}`,
      "_",
      installArg,
    ],
    { env: { ...process.env, LIB: lib }, encoding: "utf8" },
  );
  return { status: result.status, out: result.stdout, err: result.stderr };
}

/**
 * A process that looks like a pty-host to `ps` (its command line carries
 * `pty-host --socket`) and optionally holds a file open, as a host that has
 * loaded node-pty holds the native addon.
 */
async function startFakeHost(install: string, holdOpen?: string): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const f=process.argv[1];if(f)require('fs').openSync(f,'r');console.log('ready');setInterval(()=>{},1e6)",
      holdOpen ?? "",
      // The real host is `node <install>/launchd-entry.cjs pty-host --socket <sock>`.
      join(install, "launchd-entry.cjs"),
      "pty-host",
      "--socket",
      "/nonexistent/fake.sock",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  hosts.push(child);
  await new Promise<void>((ok) => child.stdout?.once("data", () => ok()));
  // `ps etime` has one-second resolution; let the host's start tick over so
  // "started before X" is unambiguous for the history-based attribution.
  await new Promise((r) => setTimeout(r, 2100));
  return child.pid as number;
}

const names = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

posixOnly("prune_builds (issue #900)", () => {
  it("keeps exactly two builds (active + rollback) and removes the rest with their sidecars", () => {
    const fx = makeInstall();
    const r = prune(fx.install);
    expect(r.status, r.err).toBe(0);
    expect(names(fx.releases).filter((n) => n.startsWith("cli."))).toEqual([
      "cli.ccc.XXXXXX", // rollback: the last history entry that is not the active build
      "cli.ddd.XXXXXX", // active
    ]);
    expect(existsSync(join(fx.releases, "cli.old1.cjs.version"))).toBe(false);
    // The activation log stays intact so deploy:rollback keeps working.
    expect(readFileSync(join(fx.releases, ".history"), "utf8").trim().split("\n")).toHaveLength(4);
    expect(readFileSync(join(fx.releases, "cli.ccc.XXXXXX", "cli.cjs.version"), "utf8")).toContain(
      "ccc",
    );
  });

  it("removes current/ and releases/<semver>/ and the staged tarballs, and nothing else", () => {
    const fx = makeInstall();
    prune(fx.install);
    expect(existsSync(join(fx.install, "current"))).toBe(false);
    expect(names(fx.releases)).not.toContain("1.90.1");
    expect(names(fx.releases)).not.toContain("1.89.6");
    expect(existsSync(join(fx.releases, ".tmp", "1.90.1-streamer.tgz"))).toBe(false);
    expect(existsSync(join(fx.releases, ".tmp"))).toBe(true);
    for (const f of [
      "cache/cache.db",
      "runtime.db",
      "server.yaml",
      "logs/stdout.log",
      "update.yaml",
    ])
      expect(readFileSync(join(fx.install, f), "utf8")).toBe("keep me");
    expect(existsSync(join(fx.install, "node_modules", "node-pty"))).toBe(true);
    expect(existsSync(join(fx.install, "cli.js"))).toBe(true);
  });

  it("removes a current symlink without following it", () => {
    const fx = makeInstall();
    rmSync(join(fx.install, "current"));
    const outside = join(fx.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious"), "x");
    symlinkSync(outside, join(fx.install, "current"));
    prune(fx.install);
    expect(existsSync(join(fx.install, "current"))).toBe(false);
    expect(readFileSync(join(outside, "precious"), "utf8")).toBe("x");
  });

  it("removes current/ when it is a real directory (copy layout)", () => {
    const fx = makeInstall();
    rmSync(join(fx.install, "current"));
    mkdirSync(join(fx.install, "current", "dist"), { recursive: true });
    writeFileSync(join(fx.install, "current", "dist", "cli.cjs"), "x");
    prune(fx.install);
    expect(existsSync(join(fx.install, "current"))).toBe(false);
  });

  it("is a no-op when there is no releases dir, current/ or history", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tb-prune-")));
    fixtures.push(dir);
    const install = join(dir, "x", "install");
    mkdirSync(install, { recursive: true });
    const r = prune(install);
    expect(r.status, r.err).toBe(0);
    expect(names(install)).toEqual([]);
    const missing = prune(join(dir, "nope", "install"));
    expect(missing.status, missing.err).toBe(0);
  });

  it("still keeps two builds when there is no history to name a rollback", () => {
    const fx = makeInstall();
    rmSync(join(fx.releases, ".history"));
    prune(fx.install);
    expect(names(fx.releases).filter((n) => n.startsWith("cli."))).toEqual([
      "cli.ccc.XXXXXX", // newest non-active
      "cli.ddd.XXXXXX",
    ]);
  });

  it("refuses a bad root and deletes nothing", () => {
    const fx = makeInstall();
    const file = join(fx.dir, "afile");
    writeFileSync(file, "x");
    for (const bad of [
      "",
      "/",
      "relative/install",
      "/tmp",
      "/private/tmp",
      "/usr/local",
      "/zzz-single-component",
      `${fx.dir}/../escape`,
      process.env.HOME ?? "/nonexistent-home",
      file,
    ]) {
      const r = prune(bad);
      expect(r.status, `root ${JSON.stringify(bad)}`).not.toBe(0);
      expect(r.err).toMatch(/refus/i);
    }
    expect(names(fx.releases)).toContain("cli.aaa.XXXXXX");
    expect(names(fx.releases)).toContain("1.90.1");
  });

  it("refuses to prune when the active build cannot be determined", () => {
    const fx = makeInstall();
    rmSync(join(fx.install, "cli.js"));
    rmSync(join(fx.releases, ".history"));
    const r = prune(fx.install);
    expect(r.status).toBe(0);
    expect(r.err).toMatch(/active build/i);
    expect(names(fx.releases)).toContain("cli.aaa.XXXXXX");
    expect(names(fx.releases)).toContain("1.90.1");
  });

  it("never removes the active build even when keep is 1 and history is empty", () => {
    const fx = makeInstall();
    writeFileSync(join(fx.releases, ".history"), "");
    prune(fx.install, 1);
    expect(names(fx.releases).filter((n) => n.startsWith("cli."))).toEqual(["cli.ddd.XXXXXX"]);
  });

  it("keeps current/ and its tree when cli.js runs from current/", () => {
    const fx = makeInstall();
    rmSync(join(fx.install, "cli.js"));
    symlinkSync("current/dist/cli.cjs", join(fx.install, "cli.js"));
    prune(fx.install);
    expect(existsSync(join(fx.install, "current"))).toBe(true);
    expect(names(fx.releases)).toContain("1.90.1");
    expect(names(fx.releases)).not.toContain("1.89.6");
    expect(names(fx.releases)).toContain("cli.ddd.XXXXXX");
  });

  it("does not count a history entry whose build is gone as the rollback target", () => {
    const now = Date.now();
    const fx = makeInstall({
      history: [
        [now - 9 * HOUR, "releases/cli.aaa.XXXXXX/cli.cjs"],
        [now - 8 * HOUR, "releases/cli.ccc.XXXXXX/cli.cjs"],
        [now - 7 * HOUR, "releases/cli.gone.XXXXXX/cli.cjs"],
        [now - 6 * HOUR, "releases/cli.ddd.XXXXXX/cli.cjs"],
      ],
    });
    prune(fx.install);
    expect(names(fx.releases).filter((n) => n.startsWith("cli."))).toEqual([
      "cli.ccc.XXXXXX",
      "cli.ddd.XXXXXX",
    ]);
  });

  it("refuses a keep count below 1", () => {
    const fx = makeInstall();
    const r = prune(fx.install, 0);
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/refus/i);
    expect(names(fx.releases)).toContain("cli.aaa.XXXXXX");
  });

  it("does nothing without a releases dir, even with a current/ and a cli.js", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tb-prune-")));
    fixtures.push(dir);
    const install = join(dir, "x", "install");
    mkdirSync(join(install, "current"), { recursive: true });
    symlinkSync("releases/cli.zzz.XXXXXX/cli.cjs", join(install, "cli.js"));
    prune(install);
    expect(existsSync(join(install, "current"))).toBe(true);
  });

  it("keeps a flat rollback artifact together with its .version sidecar", () => {
    const now = Date.now();
    const fx = makeInstall({
      history: [
        [now - 9 * HOUR, "releases/cli.aaa.XXXXXX/cli.cjs"],
        [now - 8 * HOUR, "releases/cli.old1.cjs"],
        [now - 6 * HOUR, "releases/cli.ddd.XXXXXX/cli.cjs"],
      ],
    });
    prune(fx.install);
    expect(names(fx.releases).filter((n) => n.startsWith("cli."))).toEqual([
      "cli.ddd.XXXXXX",
      "cli.old1.cjs",
      "cli.old1.cjs.version",
    ]);
  });

  describe("the deletion guard", () => {
    const rm = (install: string, target: string, cwd?: string) =>
      spawnSync("bash", ["-c", '. "$LIB"; _pb_rm "$1" "$2"', "_", install, target], {
        env: { ...process.env, LIB: lib },
        encoding: "utf8",
        cwd,
      }).status;

    it("refuses a relative target even when it spells a valid name", () => {
      const fx = makeInstall();
      const elsewhere = join(fx.dir, "elsewhere");
      mkdirSync(join(elsewhere, "current"), { recursive: true });
      expect(rm(fx.install, "current", elsewhere)).not.toBe(0);
      expect(existsSync(join(elsewhere, "current"))).toBe(true);
    });

    it("deletes only current, cli.* and semver entries under releases, and .tmp/*.tgz", () => {
      const fx = makeInstall();
      const ok = [
        "current",
        "releases/cli.aaa.XXXXXX",
        "releases/1.90.1",
        "releases/.tmp/1.90.1-streamer.tgz",
      ];
      for (const rel of ok) expect(rm(fx.install, join(fx.install, rel)), rel).toBe(0);
      for (const rel of ok) expect(existsSync(join(fx.install, rel)), rel).toBe(false);
    });

    it("refuses everything else and removes nothing", () => {
      const fx = makeInstall();
      mkdirSync(join(fx.releases, "menubar"));
      const bad = [
        fx.install,
        fx.releases,
        join(fx.releases, ".history"),
        join(fx.releases, "menubar"),
        join(fx.releases, ".tmp"),
        join(fx.releases, "cli.aaa.XXXXXX", "cli.cjs"),
        join(fx.releases, "..", "runtime.db"),
        join(fx.install, "runtime.db"),
        join(fx.install, "cache", "cache.db"),
        join(fx.install, "node_modules"),
        join(fx.install, "current", "dist"),
        join(fx.releases, ".tmp", "notes.txt"),
        join(fx.dir, "install-other", "current"),
        "",
      ];
      for (const target of bad) expect(rm(fx.install, target), target).not.toBe(0);
      expect(rm("", join(fx.install, "current"))).not.toBe(0);
      expect(rm("relative", "relative/current")).not.toBe(0);
      expect(existsSync(join(fx.releases, ".history"))).toBe(true);
      expect(existsSync(join(fx.releases, "menubar"))).toBe(true);
      expect(existsSync(join(fx.install, "runtime.db"))).toBe(true);
      expect(existsSync(join(fx.install, "cache", "cache.db"))).toBe(true);
      expect(existsSync(join(fx.install, "node_modules"))).toBe(true);
      expect(existsSync(join(fx.releases, "cli.aaa.XXXXXX", "cli.cjs"))).toBe(true);
      expect(existsSync(join(fx.install, "current"))).toBe(true);
    });
  });

  describe("a live pty-host", () => {
    it("keeps the build whose native addon the host holds open", async () => {
      const fx = makeInstall();
      const pty = join(fx.releases, "cli.aaa.XXXXXX", "node_modules", "node-pty", "pty.node");
      await startFakeHost(fx.install, pty);
      const r = prune(fx.install);
      expect(r.status, r.err).toBe(0);
      expect(names(fx.releases).filter((n) => n.startsWith("cli."))).toEqual([
        "cli.aaa.XXXXXX", // protected: a live host maps its pty.node
        "cli.ccc.XXXXXX",
        "cli.ddd.XXXXXX",
      ]);
      expect(r.out).toMatch(/pty-host/);
      // The updater trees are still pruned: the host is attributed to a deploy build.
      expect(names(fx.releases)).not.toContain("1.90.1");
    }, 15_000);

    it("keeps the updater tree whose natives a live host holds open", async () => {
      const fx = makeInstall();
      const pty = join(fx.releases, "1.89.6", "node_modules", "node-pty", "pty.node");
      writeFileSync(pty, "native");
      await startFakeHost(fx.install, pty);
      prune(fx.install);
      expect(names(fx.releases)).toContain("1.89.6");
      expect(names(fx.releases)).not.toContain("1.90.1");
    }, 15_000);

    it("keeps the build that was active when the host started, even with no open file", async () => {
      // The host has not loaded node-pty yet, so nothing is mapped. It started
      // between the bbb and ccc activations, so it runs bbb.
      const now = Date.now();
      const fx = makeInstall({
        history: [
          [now - 5 * HOUR, "releases/cli.aaa.XXXXXX/cli.cjs"],
          [now - 4 * HOUR, "releases/cli.bbb.XXXXXX/cli.cjs"],
          [now + 1 * HOUR, "releases/cli.ccc.XXXXXX/cli.cjs"],
          [now + 2 * HOUR, "releases/cli.ddd.XXXXXX/cli.cjs"],
        ],
      });
      await startFakeHost(fx.install);
      const r = prune(fx.install);
      expect(r.status, r.err).toBe(0);
      expect(names(fx.releases).filter((n) => n.startsWith("cli."))).toEqual([
        "cli.bbb.XXXXXX", // protected by start time
        "cli.ccc.XXXXXX", // rollback
        "cli.ddd.XXXXXX", // active
      ]);
    }, 15_000);

    it("trusts the files a host holds over the activation timeline", async () => {
      const now = Date.now();
      const fx = makeInstall({
        history: [
          [now - 5 * HOUR, "releases/cli.aaa.XXXXXX/cli.cjs"],
          [now - 4 * HOUR, "releases/cli.bbb.XXXXXX/cli.cjs"],
          [now + 1 * HOUR, "releases/cli.ccc.XXXXXX/cli.cjs"],
          [now + 2 * HOUR, "releases/cli.ddd.XXXXXX/cli.cjs"],
        ],
      });
      const pty = join(fx.releases, "cli.aaa.XXXXXX", "node_modules", "node-pty", "pty.node");
      await startFakeHost(fx.install, pty);
      prune(fx.install);
      // The timeline alone would say bbb; the open file says aaa.
      expect(names(fx.releases).filter((n) => n.startsWith("cli."))).toEqual([
        "cli.aaa.XXXXXX",
        "cli.ccc.XXXXXX",
        "cli.ddd.XXXXXX",
      ]);
    }, 15_000);

    it("keeps an updater tree a host started under could be running", async () => {
      // 1.90.1 was installed (mtime) before the host started and no deploy was
      // activated in between, so cli.js pointed at it when the host spawned.
      const now = Date.now();
      const fx = makeInstall({
        history: [
          [now - 30 * HOUR, "releases/cli.aaa.XXXXXX/cli.cjs"],
          [now + 1 * HOUR, "releases/cli.ccc.XXXXXX/cli.cjs"],
          [now + 2 * HOUR, "releases/cli.ddd.XXXXXX/cli.cjs"],
        ],
      });
      touch(join(fx.releases, "1.90.1"), now - 2 * HOUR);
      touch(join(fx.releases, "1.89.6"), now - 40 * HOUR);
      await startFakeHost(fx.install);
      prune(fx.install);
      expect(names(fx.releases)).toContain("1.90.1");
      expect(names(fx.releases)).not.toContain("1.89.6");
      expect(names(fx.releases)).not.toContain("cli.aaa.XXXXXX");
    }, 15_000);

    it("prunes nothing when a host's build cannot be determined", async () => {
      const now = Date.now();
      const fx = makeInstall({
        history: [
          [now + 1 * HOUR, "releases/cli.ccc.XXXXXX/cli.cjs"],
          [now + 2 * HOUR, "releases/cli.ddd.XXXXXX/cli.cjs"],
        ],
      });
      for (const v of ["1.90.1", "1.89.6"]) touch(join(fx.releases, v), now + 5 * HOUR);
      await startFakeHost(fx.install);
      const r = prune(fx.install);
      expect(r.status, r.err).toBe(0);
      expect(r.err).toMatch(/cannot tell which build/i);
      expect(names(fx.releases)).toContain("cli.aaa.XXXXXX");
      expect(names(fx.releases)).toContain("1.90.1");
      expect(existsSync(join(fx.install, "current"))).toBe(true);
    }, 15_000);
  });
});

posixOnly("warn_if_auto_update_enabled (issue #900)", () => {
  const run = (yaml: string | null) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tb-au-")));
    fixtures.push(dir);
    if (yaml !== null) writeFileSync(join(dir, "update.yaml"), yaml);
    const r = spawnSync(
      "bash",
      [
        "-c",
        `warn() { echo "WARN $*"; }; . "$LIB"; warn_if_auto_update_enabled "$1"; echo "rc=$?"`,
        "_",
        dir,
      ],
      { env: { ...process.env, LIB: lib }, encoding: "utf8" },
    );
    return r.stdout;
  };

  it("warns once, naming the setting to turn off, when auto_update is true", () => {
    const out = run("github_repo: a/b\nauto_update: true   # on\n");
    expect(out.match(/WARN/g)).toHaveLength(1);
    expect(out).toContain("auto_update: false");
    expect(out).toContain("rc=0");
  });

  it("stays silent when it is false, absent, or there is no update.yaml", () => {
    for (const yaml of [
      "auto_update: trueish\n",
      "auto_update: false\n",
      "channel: stable\n",
      "# auto_update: true\n",
      null,
    ])
      expect(run(yaml)).toBe("rc=0\n");
  });
});

describe("deploy scripts use the shared prune", () => {
  const read = (f: string) => readFileSync(join(root, "scripts", f), "utf8");

  it("deploy.sh and deploy-linux.sh keep two builds and call prune_builds instead of the inline GC", () => {
    for (const f of ["deploy.sh", "deploy-linux.sh"]) {
      const s = read(f);
      expect(s, f).toContain("KEEP_RELEASES=2");
      expect(s, f).toContain('. "$REPO_ROOT/scripts/lib/prune-builds.sh"');
      expect(s, f).toContain('prune_builds "$INSTALL_DIR" "$KEEP_RELEASES"');
      expect(s, f).toContain('warn_if_auto_update_enabled "$INSTALL_DIR"');
      expect(s, f).not.toContain("tail -n +$((KEEP_RELEASES + 1))");
    }
  });

  it("deploy.ps1 keeps two builds and calls Invoke-PruneBuilds instead of the inline GC (static only: not run on Windows)", () => {
    const s = read("deploy.ps1");
    expect(s).toContain("$keepReleases = 2");
    expect(s).toContain("lib\\prune-builds.ps1");
    expect(s).toContain("Invoke-PruneBuilds -Install $installDir -Keep $keepReleases");
    expect(s).toContain("Test-AutoUpdateEnabled -Install $installDir");
    expect(s).not.toContain("Select-Object -Skip $keepReleases");
    const lib = readFileSync(join(root, "scripts", "lib", "prune-builds.ps1"), "utf8");
    expect(lib).toContain("function Remove-PruneTarget");
    expect(lib).toContain("function Invoke-PruneBuilds");
  });
});
