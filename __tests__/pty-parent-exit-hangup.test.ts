import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Pins the process-lifetime assumption the durable-session-runtime design rests
 * on (docs/architecture/2026-07-24-durable-session-runtime.md).
 *
 * node-pty spawns with POSIX_SPAWN_SETSID, so an agent is its own session
 * leader and no *process-group* signal from the streamer reaches it. It is
 * tempting to conclude agents would survive a streamer exit if we simply
 * stopped calling kill(). They do not: closing the last PTY **master** fd makes
 * the kernel send SIGHUP to the foreground process group of that terminal — and
 * setsid is precisely what elects the agent to receive it.
 *
 * That is why restart survival needs the master fd to outlive the streamer
 * (deferred to the daemon follow-up) rather than just a deleted kill() call. If
 * a node-pty upgrade ever changes this, these tests fail and the design doc's
 * central claim gets revisited instead of silently rotting.
 *
 * Each case runs in a child node process that exits WITHOUT killing its PTY
 * child, then we inspect how far the grandchild's heartbeat got.
 */

// A child that ignores SIGHUP runs for ~2.5s of heartbeats; the parent exits at
// 400ms. Generous margins keep this off the flake list on a loaded machine.
const BEATS = 10;
const BEAT_INTERVAL = "0.25";
const PARENT_EXIT_MS = 400;

function runProbe(trapHup: boolean): number {
  const dir = mkdtempSync(join(tmpdir(), "tb-hangup-"));
  const marker = join(dir, "beats.txt");
  const trap = trapHup ? "trap '' HUP; " : "";

  const script = `
    const pty = require(${JSON.stringify(require.resolve("node-pty"))});
    pty.spawn('/bin/sh', ['-c', ${JSON.stringify(
      `${trap}for i in $(seq 1 ${BEATS}); do echo b >> ${marker}; sleep ${BEAT_INTERVAL}; done`,
    )}], { name: 'xterm-256color', cols: 80, rows: 24, cwd: ${JSON.stringify(dir)}, env: process.env });
    setTimeout(() => process.exit(0), ${PARENT_EXIT_MS});
  `;

  // The parent exits on its own; wait past the full heartbeat run before
  // counting, so a surviving child has time to finish.
  spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  spawnSync("/bin/sh", ["-c", `sleep ${BEATS * Number(BEAT_INTERVAL) + 1}`]);

  const beats = existsSync(marker)
    ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length
    : 0;
  rmSync(dir, { recursive: true, force: true });
  return beats;
}

// POSIX-only: SIGHUP-on-master-close and setsid are not Windows semantics.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("PTY child lifetime when the parent exits without killing it", () => {
  it("dies on parent exit despite setsid — the master fd closing hangs it up", () => {
    const beats = runProbe(false);
    // Died with the parent: only the beats emitted before PARENT_EXIT_MS.
    expect(beats).toBeGreaterThan(0); // it did start
    expect(beats).toBeLessThan(BEATS); // but it did not finish
  }, 30_000);

  it("survives the same parent exit when it ignores SIGHUP", () => {
    const beats = runProbe(true);
    // Ran to completion long after its parent was gone — proving the killer is
    // SIGHUP delivery, not process-group teardown or fd starvation.
    expect(beats).toBe(BEATS);
  }, 30_000);
});
