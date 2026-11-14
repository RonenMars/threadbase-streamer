import { vi } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("fs", async (orig) => ({ ...(await orig<typeof import("fs")>()), existsSync: vi.fn() }));

import { execFile } from "child_process";
import { existsSync } from "fs";
import { installedTerminal, launchTerminal, tmuxHasClient } from "../src/handoff/terminal";

const calls: { file: string; args: string[]; opts: { timeout?: number } }[] = [];

function scriptExec(reply: { err?: Error; stdout?: string } = {}) {
  type Cb = (e: Error | null, r: { stdout: string; stderr: string }) => void;
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    optsOrCb: { timeout?: number } | Cb,
    lastCb?: Cb,
  ) => {
    const cb = typeof optsOrCb === "function" ? optsOrCb : (lastCb as Cb);
    const opts = typeof optsOrCb === "function" ? {} : optsOrCb;
    calls.push({ file, args, opts });
    cb(reply.err ?? null, { stdout: reply.stdout ?? "", stderr: "" });
  }) as never);
}

describe("handoff terminal", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("opens Ghostty on the threadbase session with argv, not a shell", async () => {
    scriptExec();
    await launchTerminal("ghostty", "/opt/homebrew/bin/tmux");
    expect(calls).toEqual([
      {
        file: "/usr/bin/open",
        args: [
          "-na",
          "Ghostty",
          "--args",
          "-e",
          "/opt/homebrew/bin/tmux",
          "attach",
          "-t",
          "threadbase",
        ],
        opts: { timeout: 3000 },
      },
    ]);
  });

  it("opens Terminal through osascript, quoting the tmux path for the shell and AppleScript", async () => {
    scriptExec();
    await launchTerminal("terminal", "/opt/homebrew/bin/tmux");
    expect(calls).toEqual([
      {
        file: "/usr/bin/osascript",
        args: [
          "-e",
          'tell application "Terminal"',
          "-e",
          `do script "'/opt/homebrew/bin/tmux' attach -t threadbase"`,
          "-e",
          "activate",
          "-e",
          "end tell",
        ],
        opts: { timeout: 3000 },
      },
    ]);
    calls.length = 0;
    await launchTerminal("terminal", `/my "tools"/it's/tmux`);
    expect(calls[0].args[3]).toBe(
      `do script "'/my \\"tools\\"/it'\\\\''s/tmux' attach -t threadbase"`,
    );
  });

  it("rejects when the launch fails or times out (osascript waiting on the Automation prompt)", async () => {
    scriptExec({
      err: Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }),
    });
    await expect(launchTerminal("terminal", "/opt/tmux")).rejects.toThrow("Command failed");
  });

  it("asks tmux whether a client is attached to the threadbase session", async () => {
    scriptExec({ stdout: "" });
    await expect(tmuxHasClient("/opt/tmux")).resolves.toBe(false);
    expect(calls[0]).toMatchObject({
      file: "/opt/tmux",
      args: ["list-clients", "-t", "=threadbase"],
    });
    scriptExec({ stdout: "/dev/ttys003: threadbase [120x40 xterm-ghostty] (utf8)\n" });
    await expect(tmuxHasClient("/opt/tmux")).resolves.toBe(true);
  });

  it("reports a configured terminal only while its app is on disk", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(installedTerminal("none")).toBeNull();
    expect(installedTerminal("ghostty")).toEqual({
      name: "Ghostty",
      appPath: "/Applications/Ghostty.app",
    });
    expect(installedTerminal("terminal")).toEqual({
      name: "Terminal",
      appPath: "/System/Applications/Utilities/Terminal.app",
    });
    expect(existsSync).toHaveBeenLastCalledWith("/System/Applications/Utilities/Terminal.app");
    vi.mocked(existsSync).mockReturnValue(false);
    expect(installedTerminal("ghostty")).toBeNull();
  });
});
