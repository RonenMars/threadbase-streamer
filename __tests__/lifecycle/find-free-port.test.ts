import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { findFreePort } from "../../src/lifecycle/dev-takeover";

function listen(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

describe("findFreePort", () => {
  let blockers: Server[] = [];
  afterEach(async () => {
    for (const s of blockers) await new Promise<void>((r) => s.close(() => r()));
    blockers = [];
  });

  it("returns the start port when it is free", async () => {
    expect(await findFreePort(55000)).toBe(55000);
  });

  it("walks past a bound port to the next free one", async () => {
    blockers.push(await listen(55001));
    const free = await findFreePort(55001);
    expect(free).toBeGreaterThan(55001);
    expect(free).toBeLessThan(55051);
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
