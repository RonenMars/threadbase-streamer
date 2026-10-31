import { vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../src/logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));
vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout?: string) => void,
  ) => {
    if (cmd === "ps" && args[0] === "-eo") return cb(null, "  4242 claude\n");
    return cb(new Error(`spawn ${cmd} EMFILE`));
  },
}));
vi.mock("../src/platform", async (orig) => ({
  ...(await orig<typeof import("../src/platform")>()),
  isWindows: false,
}));
vi.mock("os", async (orig) => ({
  ...(await orig<typeof import("os")>()),
  platform: () => "darwin",
}));

import { discoverClaudeProcesses } from "../src/process-discovery";

describe("discoverClaudeProcesses — failures are logged, not swallowed", () => {
  it("logs the pid and reason when reading a swept process fails", async () => {
    const found = await discoverClaudeProcesses();

    expect(found).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("4242"),
      expect.objectContaining({ event: "discovery.process_unreadable", pid: 4242 }),
    );
  });
});
