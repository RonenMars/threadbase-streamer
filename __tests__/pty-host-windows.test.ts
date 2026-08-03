import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const WINDOWS_BEATS = 12;
const WINDOWS_BEAT_INTERVAL_MS = 200;
const STREAMER_EXIT_DELAY_MS = 250;

// The beats themselves take WINDOWS_BEATS * WINDOWS_BEAT_INTERVAL_MS ≈ 2.4s.
// Everything above that is headroom for a cold `powershell.exe` start, which on
// a loaded GitHub runner is the dominant and highly variable cost — the first
// observed flake produced *zero* beats inside an 8s budget while the run itself
// took 9.1s against a 5.4s baseline.
//
// These three are a chain and must be raised together, weakest link first:
// the host kills the PTY at HOST_PTY_KILL_MS, so waiting longer than that
// cannot help, and the vitest timeout has to outlast the wait.
const HOST_PTY_KILL_MS = 45_000;
const OUTPUT_WAIT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForOutput(path: string, marker: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let output = readIfPresent(path);
  while (!output.includes(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    output = readIfPresent(path);
  }
  return output;
}

describe.skipIf(process.platform !== "win32")("Windows detached PTY host lifetime", () => {
  it(
    "keeps ConPTY output flowing after the streamer process exits",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tb-conpty-host-"));
      const outputPath = join(dir, "output.txt");
      const readyPath = join(dir, "ready.json");
      const hostPidPath = join(dir, "host.pid");
      let hostPid = 0;

      const powershellCommand = [
        `$ErrorActionPreference = "Stop"`,
        `for ($i = 1; $i -le ${WINDOWS_BEATS}; $i++) {`,
        `Write-Output ("PTY_BEAT_" + $i)`,
        `Start-Sleep -Milliseconds ${WINDOWS_BEAT_INTERVAL_MS}`,
        `}`,
        `Write-Output "PTY_COMPLETE"`,
      ].join("; ");
      const hostScript = `
      const { appendFileSync, writeFileSync } = require("node:fs");
      const pty = require(${JSON.stringify(require.resolve("node-pty"))});
      const child = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ${JSON.stringify(
        powershellCommand,
      )}], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        // NOT \`dir\`. Windows refuses to remove a directory that is any live
        // process's working directory, and ConPTY's side process (conhost /
        // OpenConsole) is not reliably a child of the tree \`taskkill /T /F\`
        // kills — so it can outlive the kill still holding this CWD, and the
        // cleanup below then fails with EBUSY no matter how long it retries.
        // Nothing here needs \`dir\` as a working directory: outputPath,
        // readyPath and hostPidPath are absolute joins, and the PowerShell
        // command only writes to stdout.
        cwd: ${JSON.stringify(tmpdir())},
        env: process.env,
      });
      child.onData((data) => appendFileSync(${JSON.stringify(outputPath)}, data));
      child.onExit(() => {
        appendFileSync(${JSON.stringify(outputPath)}, "HOST_EXIT\\r\\n");
        process.exit(0);
      });
      writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ hostPid: process.pid, ptyPid: child.pid }));
      setTimeout(() => {
        child.kill();
        process.exit(2);
      }, ${HOST_PTY_KILL_MS});
    `;
      const launcherScript = `
      const { spawn } = require("node:child_process");
      const { existsSync, writeFileSync } = require("node:fs");
      const host = spawn(process.execPath, ["-e", ${JSON.stringify(hostScript)}], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      writeFileSync(${JSON.stringify(hostPidPath)}, String(host.pid));
      host.unref();
      const deadline = Date.now() + 5000;
      const waitForReady = () => {
        if (existsSync(${JSON.stringify(readyPath)})) {
          setTimeout(() => process.exit(0), ${STREAMER_EXIT_DELAY_MS});
        } else if (Date.now() >= deadline) {
          process.exit(3);
        } else {
          setTimeout(waitForReady, 50);
        }
      };
      waitForReady();
    `;

      try {
        const launcher = spawnSync(process.execPath, ["-e", launcherScript], {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        });
        hostPid = Number.parseInt(readIfPresent(hostPidPath), 10);
        const ready = JSON.parse(readIfPresent(readyPath)) as { hostPid: number; ptyPid: number };
        const outputAtStreamerExit = readIfPresent(outputPath);

        expect(launcher.error).toBeUndefined();
        expect(launcher.status).toBe(0);
        expect(ready.hostPid).toBe(hostPid);
        expect(ready.ptyPid).toBeGreaterThan(0);
        expect(outputAtStreamerExit).not.toContain("PTY_COMPLETE");
        expect(isPidAlive(hostPid)).toBe(true);

        const finalOutput = await waitForOutput(outputPath, "PTY_COMPLETE", OUTPUT_WAIT_MS);
        // `String.match` returns null when nothing matched, and `toHaveLength` on
        // null reports only "Target cannot be null or undefined" — which is what
        // the first flake produced, hiding the fact that the file was empty.
        // Coalesce and attach the tail so a timeout says what was actually seen.
        const beats = finalOutput.match(/PTY_BEAT_/g) ?? [];
        const seen = `captured ${finalOutput.length} bytes, tail: ${JSON.stringify(finalOutput.slice(-200))}`;
        expect(beats, `expected ${WINDOWS_BEATS} beats — ${seen}`).toHaveLength(WINDOWS_BEATS);
        expect(finalOutput, seen).toContain("PTY_COMPLETE");
      } finally {
        if (hostPid > 0 && isPidAlive(hostPid)) {
          spawnSync("taskkill.exe", ["/PID", String(hostPid), "/T", "/F"], { windowsHide: true });
        }
        // `taskkill /F` returns once the terminate request is issued; Windows
        // releases the process's handles afterwards, on its own schedule, so
        // `force: true` — which suppresses ENOENT, not EBUSY — is not enough on
        // its own and the retries below cover a straggling handle on output.txt.
        //
        // The retries are NOT what fixes the EBUSY this test kept hitting, and
        // an earlier version of this comment claimed they were. Ten attempts
        // over ~1s were already in place on `df5b737` and the job still failed
        // the same way: a 1s exhaustion inside an 8.6s test means something was
        // still holding the directory, not slowly letting go of it. That was
        // the ConPTY child's `cwd`, which now points outside `dir` — see
        // hostScript. No backoff length can fix a live working directory.
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
