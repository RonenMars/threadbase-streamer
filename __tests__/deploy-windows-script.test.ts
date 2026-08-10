import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { logPaths } from "../src/lifecycle/constants";
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
  it("redirects the supervised launcher's output into the logs directory", () => {
    const { stdout, stderr } = logPaths();
    expect(deployScript).toContain(
      `$logsDir = Join-Path $installDir '${basename(dirname(stdout))}'`,
    );
    expect(deployScript).toContain(`$outLog = Join-Path $logsDir '${basename(stdout)}'`);
    expect(deployScript).toContain(`$errLog = Join-Path $logsDir '${basename(stderr)}'`);
    expect(deployScript).toContain('>> `"$outLog`" 2>> `"$errLog`"');
    // cmd fails the redirect (and so the whole server start) if the directory is
    // gone, and the failure has nowhere to be reported.
    expect(deployScript).toContain('if not exist `"$logsDir`" mkdir `"$logsDir`"');
  });

  it("self-heals a launch.cmd written before the redirection existed", () => {
    expect(deployScript).toContain("if ($content -notmatch '>>')");
  });

  it("points prod logs at the files the launcher redirects into", () => {
    expect(getLogPaths()).toEqual(logPaths());
  });
});
