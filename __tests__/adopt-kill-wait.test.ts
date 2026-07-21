import { spawn } from "child_process";
import { ADOPT_KILL_TIMEOUT_MS, waitForProcessExit } from "../src/server";

// P0.7: adopt must WAIT for the external process to die before spawning its
// replacement. SIGTERM is asynchronous — spawning `claude --resume` on the same
// conversation while the old process is still alive puts two agents in one
// JSONL, the interleaved-transcript state nothing downstream can repair.
describe("waitForProcessExit", () => {
  it("returns true once the process is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    await new Promise((resolve) => child.once("spawn", resolve));

    const pid = child.pid as number;
    // Still alive → the wait must not resolve true immediately.
    expect(await waitForProcessExit(pid, 150, 25)).toBe(false);

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(await waitForProcessExit(pid, 2_000, 25)).toBe(true);
  });

  it("returns true immediately for a pid that never existed", async () => {
    // 2^31-1 is not a live pid on any platform we run on.
    expect(await waitForProcessExit(2_147_483_647, 1_000, 25)).toBe(true);
  });

  it("gives up after the timeout rather than blocking forever", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    await new Promise((resolve) => child.once("spawn", resolve));

    const startedAt = Date.now();
    const exited = await waitForProcessExit(child.pid as number, 200, 25);
    const elapsed = Date.now() - startedAt;

    expect(exited).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  });

  it("exposes a bounded default timeout for the adopt path", () => {
    expect(ADOPT_KILL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ADOPT_KILL_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
