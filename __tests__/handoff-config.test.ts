import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffConfigPath, readHandoffConfig, writeHandoffConfig } from "../src/handoff/config";

describe("handoff config", () => {
  let dir: string;
  const prev = process.env.THREADBASE_CONFIG_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-handoff-config-"));
    process.env.THREADBASE_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  // Any existing file stands in for tmux.
  const tmux = process.execPath;

  it("round-trips an enabled config on darwin, terminal included", () => {
    writeHandoffConfig({ enabled: true, tmuxPath: tmux, terminal: "ghostty" });
    expect(readHandoffConfig("darwin")).toEqual({
      enabled: true,
      tmuxPath: tmux,
      terminal: "ghostty",
    });
    writeHandoffConfig({ enabled: true, tmuxPath: tmux, terminal: "terminal" });
    expect(readHandoffConfig("darwin")?.terminal).toBe("terminal");
  });

  it("reads a missing or unknown terminal as none, so a Phase 1 file keeps working", () => {
    writeFileSync(handoffConfigPath(), JSON.stringify({ enabled: true, tmuxPath: tmux }));
    expect(readHandoffConfig("darwin")).toEqual({
      enabled: true,
      tmuxPath: tmux,
      terminal: "none",
    });
    writeFileSync(
      handoffConfigPath(),
      JSON.stringify({ enabled: true, tmuxPath: tmux, terminal: "iterm2" }),
    );
    expect(readHandoffConfig("darwin")?.terminal).toBe("none");
  });

  it("is off on anything but darwin", () => {
    writeHandoffConfig({ enabled: true, tmuxPath: tmux, terminal: "none" });
    expect(readHandoffConfig("linux")).toBeNull();
  });

  it("is off when missing, invalid, disabled, or tmux is gone", () => {
    expect(readHandoffConfig("darwin")).toBeNull();
    writeFileSync(handoffConfigPath(), "{not json");
    expect(readHandoffConfig("darwin")).toBeNull();
    writeHandoffConfig({ enabled: false, tmuxPath: tmux, terminal: "none" });
    expect(readHandoffConfig("darwin")).toBeNull();
    writeHandoffConfig({ enabled: true, tmuxPath: join(dir, "no-tmux"), terminal: "none" });
    expect(readHandoffConfig("darwin")).toBeNull();
  });
});
