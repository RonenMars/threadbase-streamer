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
      // No terminal app installed: the menu is 1) tmux only, 2) Disable.
      appExists: () => false,
      ...over,
    });

  it("enables, then disables, with tmux resolved to an absolute path", async () => {
    expect(await run("1")).toBe(0);
    expect(readHandoffConfig("darwin")).toEqual({
      enabled: true,
      tmuxPath: tmux,
      terminal: "none",
    });
    // Enter keeps the current value.
    expect(await run("")).toBe(0);
    expect(readHandoffConfig("darwin")).not.toBeNull();
    expect(await run("2")).toBe(0);
    expect(readHandoffConfig("darwin")).toBeNull();
    // ...in both directions.
    expect(await run("")).toBe(0);
    expect(readHandoffConfig("darwin")).toBeNull();
  });

  it("offers only the terminal apps on disk, and defaults to the current choice", async () => {
    const questions: string[] = [];
    const withApps = (answer: string, apps: string[]) =>
      run(answer, {
        appExists: (p: string) => apps.some((a) => p.includes(a)),
        ask: async (q: string) => {
          questions.push(q);
          return answer;
        },
      });
    // Both apps: 1) Ghostty 2) Terminal 3) tmux only 4) Disable; off by default.
    expect(await withApps("", ["Ghostty", "Terminal"])).toBe(0);
    expect(questions.at(-1)).toBe("Choice [4]: ");
    expect(readHandoffConfig("darwin")).toBeNull();
    expect(out.at(-2)).toMatch(
      /1\) Ghostty\n {2}2\) Terminal\n {2}3\) Don't open a terminal \(tmux only\)\n {2}4\) Disable handoff/,
    );
    expect(await withApps("2", ["Ghostty", "Terminal"])).toBe(0);
    expect(readHandoffConfig("darwin")?.terminal).toBe("terminal");
    expect(await withApps("", ["Ghostty", "Terminal"])).toBe(0);
    expect(questions.at(-1)).toBe("Choice [2]: ");
    expect(readHandoffConfig("darwin")?.terminal).toBe("terminal");
    // Ghostty missing: Terminal moves up to 1.
    expect(await withApps("1", ["Terminal"])).toBe(0);
    expect(questions.at(-1)).toBe("Choice [1]: ");
    expect(readHandoffConfig("darwin")?.terminal).toBe("terminal");
    // The configured app is gone: the default falls back to tmux only.
    expect(await withApps("", [])).toBe(0);
    expect(questions.at(-1)).toBe("Choice [1]: ");
    expect(readHandoffConfig("darwin")).toMatchObject({ enabled: true, terminal: "none" });
    expect(await withApps("3", ["Ghostty", "Terminal"])).toBe(0);
    expect(readHandoffConfig("darwin")).toMatchObject({ enabled: true, terminal: "none" });
    expect(await withApps("4", ["Ghostty", "Terminal"])).toBe(0);
    expect(readHandoffConfig("darwin")).toBeNull();
    expect(await withApps("5", ["Ghostty", "Terminal"])).toBe(1);
  });

  it("refuses off macOS, without tmux, and on an unknown choice", async () => {
    expect(await run("1", { platform: "linux" })).toBe(1);
    expect(await run("1", { locate: () => null })).toBe(1);
    expect(out.join("\n")).toContain("brew install tmux");
    expect(await run("9")).toBe(1);
    expect(readHandoffConfig("darwin")).toBeNull();
  });
});
