import { vi } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "child_process";
import { openTmuxWindow } from "../src/handoff/tmux";

type Reply = { err?: Error; stdout?: string };
const calls: string[][] = [];
const envs: unknown[] = [];

function scriptTmux(replies: Record<string, Reply>) {
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    opts: { env: unknown },
    cb: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push(args);
    envs.push(opts.env);
    const r = replies[args[0]] ?? {};
    cb(r.err ?? null, { stdout: r.stdout ?? "", stderr: "" });
  }) as never);
}

const opts = {
  name: "app-abc123",
  cwd: "/work/app",
  argv: ["/bin/claude", "--resume", "x"],
  env: { PATH: "/bin" },
  settleMs: 0,
};

describe("openTmuxWindow", () => {
  beforeEach(() => {
    calls.length = 0;
    envs.length = 0;
  });

  it("creates the session detached when it is missing", async () => {
    scriptTmux({
      "has-session": { err: new Error("no session") },
      "new-session": { stdout: "%7\n" },
      "display-message": { stdout: "0\n" },
    });
    await expect(openTmuxWindow("/opt/tmux", opts)).resolves.toBe("%7");
    expect(calls[1]).toEqual([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      "threadbase",
      "-n",
      "app-abc123",
      "-c",
      "/work/app",
      "--",
      "/bin/claude",
      "--resume",
      "x",
    ]);
    expect(calls[2]).toEqual(["display-message", "-p", "-t", "%7", "#{pane_dead}"]);
    expect(envs.every((e) => e === opts.env)).toBe(true);
  });

  it("adds a window to an existing session", async () => {
    scriptTmux({ "new-window": { stdout: "%8\n" }, "display-message": { stdout: "0\n" } });
    await openTmuxWindow("/opt/tmux", opts);
    expect(calls[1].slice(0, 6)).toEqual([
      "new-window",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "=threadbase:",
    ]);
  });

  it("rejects when the pane is gone or dead after settling", async () => {
    scriptTmux({
      "new-window": { stdout: "%9\n" },
      "display-message": { err: new Error("can't find pane") },
    });
    await expect(openTmuxWindow("/opt/tmux", opts)).rejects.toThrow();
    scriptTmux({ "new-window": { stdout: "%9\n" }, "display-message": { stdout: "1\n" } });
    await expect(openTmuxWindow("/opt/tmux", opts)).rejects.toThrow(/exited/);
  });

  it("rejects when tmux itself fails", async () => {
    scriptTmux({ "new-window": { err: new Error("boom") } });
    await expect(openTmuxWindow("/opt/tmux", opts)).rejects.toThrow("boom");
  });
});
