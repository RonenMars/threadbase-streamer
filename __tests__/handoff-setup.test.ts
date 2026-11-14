import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandoffSetup } from "../cli/handoffSetup";
import { readHandoffConfig } from "../src/handoff/config";

describe("tb-streamer handoff setup", () => {
  let dir: string;
  const prev = process.env.THREADBASE_CONFIG_DIR;
  const out: string[] = [];
  const log = { info: (m: string) => out.push(m), error: (m: string) => out.push(m) };
  const tmux = process.execPath;
  beforeEach(() => {
    out.length = 0;
    dir = mkdtempSync(join(tmpdir(), "tb-handoff-setup-"));
    process.env.THREADBASE_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (answer: string, over: object = {}) =>
    runHandoffSetup({
      log,
      platform: "darwin",
      locate: () => tmux,
      ask: async () => answer,
      ...over,
    });

  it("enables, then disables, with tmux resolved to an absolute path", async () => {
    expect(await run("1")).toBe(0);
    expect(readHandoffConfig("darwin")).toEqual({ enabled: true, tmuxPath: tmux });
    // Enter keeps the current value.
    expect(await run("")).toBe(0);
    expect(readHandoffConfig("darwin")).not.toBeNull();
    expect(await run("2")).toBe(0);
    expect(readHandoffConfig("darwin")).toBeNull();
  });

  it("refuses off macOS, without tmux, and on an unknown choice", async () => {
    expect(await run("1", { platform: "linux" })).toBe(1);
    expect(await run("1", { locate: () => null })).toBe(1);
    expect(out.join("\n")).toContain("brew install tmux");
    expect(await run("9")).toBe(1);
    expect(readHandoffConfig("darwin")).toBeNull();
  });
});
