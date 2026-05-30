import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  bootoutAgent,
  bootstrapAgent,
  getAgentPid,
  isAgentLoaded,
  kickstartAgent,
} from "../../src/lifecycle/task-scheduler";

describe("task-scheduler wrappers", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("isAgentLoaded calls Get-ScheduledTask -TaskName 'Threadbase'", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("Ready"));
    expect(isAgentLoaded()).toBe(true);
    const call = vi.mocked(execFileSync).mock.calls[0];
    expect(call[0]).toBe("powershell.exe");
    expect((call[1] as string[]).join(" ")).toMatch(/Get-ScheduledTask.*Threadbase/);
  });

  it("isAgentLoaded returns false when Get-ScheduledTask throws", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Task not found");
    });
    expect(isAgentLoaded()).toBe(false);
  });

  it("bootoutAgent runs Stop-ScheduledTask + Disable-ScheduledTask, swallows errors", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("nope");
    });
    expect(() => bootoutAgent()).not.toThrow();
  });

  it("bootstrapAgent runs Enable-ScheduledTask + Start-ScheduledTask", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    bootstrapAgent("");
    const cmds = vi.mocked(execFileSync).mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(cmds.some((c) => /Enable-ScheduledTask/.test(c))).toBe(true);
    expect(cmds.some((c) => /Start-ScheduledTask/.test(c))).toBe(true);
  });

  it("kickstartAgent runs Stop-ScheduledTask + Start-ScheduledTask", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    kickstartAgent();
    const cmds = vi.mocked(execFileSync).mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(cmds.some((c) => /Stop-ScheduledTask/.test(c))).toBe(true);
    expect(cmds.some((c) => /Start-ScheduledTask/.test(c))).toBe(true);
  });

  it("getAgentPid parses the PID from Get-CimInstance output", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("12345\r\n"));
    expect(getAgentPid()).toBe(12345);
  });

  it("getAgentPid returns null when output is empty", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    expect(getAgentPid()).toBeNull();
  });

  it("getAgentPid returns null when PowerShell errors", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(getAgentPid()).toBeNull();
  });
});
