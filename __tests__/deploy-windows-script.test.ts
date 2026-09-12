import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getLogPaths } from "../src/lifecycle/task-scheduler";

const deployScript = readFileSync(resolve(import.meta.dirname, "../scripts/deploy.ps1"), "utf8");

describe("Windows deploy script", () => {
  it("skips the npm registry check for force deployments", () => {
    expect(deployScript).toContain("[switch]$SkipVersionCheck");
    expect(deployScript).toContain("if ($SkipVersionCheck -or $Force)");
  });

  it("bounds the visible npm registry check", () => {
    expect(deployScript).toContain("checking npm for a newer published version (5s timeout)");
    expect(deployScript).toContain("--fetch-timeout=5000 --fetch-retries=0");
  });

  // Task Scheduler has no native stdout/stderr redirection, so launch.cmd's `>>`
  // is the only thing that produces logs at all on Windows. These expectations
  // are derived from logPaths() rather than written out, so renaming a log file
  // on the TypeScript side fails here instead of silently orphaning the launcher.
  // Scoped to Get-LaunchCmdLines rather than the whole file. Invoke-Setup
  // carries its own identical `$logsDir = ...` line, so a whole-file toContain
  // passed even with the launcher's copy deleted — which would have built the
  // redirect targets from `Join-Path $null`, breaking logging while the test
  // written to lock it stayed green.
  const launcherBody = (() => {
    const start = deployScript.indexOf("function Get-LaunchCmdLines");
    expect(start).toBeGreaterThan(-1);
    const next = deployScript.indexOf("\nfunction ", start + 1);
    return deployScript.slice(start, next === -1 ? undefined : next);
  })();

  it("redirects the supervised launcher's output into the logs directory", () => {
    // Derived from getLogPaths() — what `prod logs` actually reads — so the
    // assertion spans the PS/TS boundary instead of comparing TS to itself.
    const { stdout, stderr } = getLogPaths();
    expect(launcherBody).toContain(
      `$logsDir = Join-Path $installDir '${basename(dirname(stdout))}'`,
    );
    expect(launcherBody).toContain(`$outLog = Join-Path $logsDir '${basename(stdout)}'`);
    expect(launcherBody).toContain(`$errLog = Join-Path $logsDir '${basename(stderr)}'`);
    expect(launcherBody).toContain('>> `"$outLog`" 2>> `"$errLog`"');
    // cmd fails the redirect (and so the whole server start) if the directory is
    // gone, and the failure has nowhere to be reported.
    expect(launcherBody).toContain('if not exist `"$logsDir`" mkdir `"$logsDir`"');
  });

  it("self-heals a launch.cmd written before the redirection existed", () => {
    expect(deployScript).toContain("if ($content -notmatch '>>')");
  });

  // Every native-module copy must clear its destination first. Copy-Item -Recurse
  // into an existing directory copies the source INTO it, so an unguarded copy
  // left a nested node-pty/node-pty on every deploy after the first — 64 MB that
  // require.resolve never reaches. Scoped to the node-pty block, because a
  // whole-file check passes on the better-sqlite3 loop's guard alone.
  const nodePtyBlock = (() => {
    const start = deployScript.indexOf("$nodePtySrc = Join-Path $repoRoot");
    expect(start).toBeGreaterThan(-1);
    const end = deployScript.indexOf("better-sqlite3 is external", start);
    expect(end).toBeGreaterThan(start);
    return deployScript.slice(start, end);
  })();

  it("clears the node-pty destination before copying into it", () => {
    expect(nodePtyBlock).toContain(
      "if (Test-Path $nodePtyDst) { Remove-Item -Path $nodePtyDst -Recurse -Force }",
    );
  });

  it("removes before it copies, not after", () => {
    const remove = nodePtyBlock.indexOf("Remove-Item -Path $nodePtyDst");
    const copy = nodePtyBlock.indexOf("Copy-Item -Path $nodePtySrc");
    expect(remove).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(-1);
    expect(remove).toBeLessThan(copy);
  });

  it("resolves the same log paths the supervisor backend reports", () => {
    // Not getLogPaths() vs logPaths() — task-scheduler's getLogPaths is
    // `return logPaths()`, so that compared a function to itself and could
    // never fail. Assert the shape the launcher depends on instead.
    const { stdout, stderr } = getLogPaths();
    expect(basename(dirname(stdout))).toBe(basename(dirname(stderr)));
    expect(basename(stdout)).toBe("stdout.log");
    expect(basename(stderr)).toBe("stderr.log");
  });
});
