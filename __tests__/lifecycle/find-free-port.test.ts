import { type AddressInfo, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { findFreePort } from "../../src/lifecycle/dev-takeover";

// Rejects on a failed bind. Without the error handler the promise simply never
// settles, so a taken port surfaces as a 15s vitest timeout plus an uncaught
// EADDRINUSE rather than as the bind failure it is.
function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

// Ports for these fixtures come from the OS, never hardcoded: every port high
// enough to be safe to bind is inside the Windows dynamic range (49152-65535),
// so a fixed number can already be held — by an unrelated process, by a Hyper-V
// reserved block, or by a server an earlier test file leaked, since the whole
// suite shares one fork.
function boundPort(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

describe("findFreePort", () => {
  let blockers: Server[] = [];
  afterEach(async () => {
    for (const s of blockers) await new Promise<void>((r) => s.close(() => r()));
    blockers = [];
  });

  it("returns the start port when it is free", async () => {
    // Bind port 0 to have the OS name a free port, then hand it back before
    // asking findFreePort for it.
    const probe = await listen(0);
    const free = boundPort(probe);
    await new Promise<void>((r) => probe.close(() => r()));

    expect(await findFreePort(free)).toBe(free);
  });

  it("walks past a bound port to the next free one", async () => {
    const blocker = await listen(0);
    blockers.push(blocker);
    const taken = boundPort(blocker);

    const free = await findFreePort(taken);
    expect(free).toBeGreaterThan(taken);
    expect(free).toBeLessThan(taken + 50);
  });

  // Binds 50 consecutive ports; on Windows the 55100–55149 window routinely
  // overlaps a dynamic/Hyper-V reserved range, so listen() throws EACCES during
  // setup and the test flakes. The findFreePort logic itself is platform-neutral
  // and exercised by the two tests above, so skip the 50-port sweep on Windows.
  it.skipIf(process.platform === "win32")(
    "returns start if no free port within the 50-port window",
    async () => {
      for (let p = 55100; p < 55150; p++) blockers.push(await listen(p));
      expect(await findFreePort(55100)).toBe(55100);
    },
  );
});
