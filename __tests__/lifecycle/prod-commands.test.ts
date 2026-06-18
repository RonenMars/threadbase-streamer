import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSupervisorLogs,
  registerProdCommands,
  runProdDoctor,
  runProdLogs,
  runProdStart,
  runProdStatus,
  runProdStop,
} from "../../cli/prod";
import { writeMarker } from "../../src/lifecycle/marker";

const mockSup = {
  isAgentLoaded: vi.fn(() => true),
  bootoutAgent: vi.fn(),
  bootstrapAgent: vi.fn(),
  kickstartAgent: vi.fn(),
  getAgentPid: vi.fn(() => 12345 as number | null),
  getLogPaths: vi.fn(() => ({ stdout: "/fake/stdout.log", stderr: "/fake/stderr.log" })),
};

vi.mock("../../src/lifecycle/platform", () => ({
  getSupervisor: () => mockSup,
}));

describe("prod commands", () => {
  let dir: string;
  let stdoutLog: string;
  let stderrLog: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prod-test-"));
    stdoutLog = join(dir, "stdout.log");
    stderrLog = join(dir, "stderr.log");
    mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutLog, "stdout");
    writeFileSync(stderrLog, "stderr");
    process.env.THREADBASE_INSTALL_DIR = dir;
    vi.clearAllMocks();
    // Reset defaults that clearAllMocks wipes
    mockSup.isAgentLoaded.mockReturnValue(true);
    mockSup.getAgentPid.mockReturnValue(12345);
    mockSup.getLogPaths.mockReturnValue({ stdout: stdoutLog, stderr: stderrLog });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("clears logs by default when asked", () => {
    clearSupervisorLogs();
    expect(readFileSync(stdoutLog, "utf8")).toBe("");
    expect(readFileSync(stderrLog, "utf8")).toBe("");
  });

  it("preserve-logs keeps the existing files intact for start and restart", async () => {
    const program = new Command();
    registerProdCommands(program);

    await program.parseAsync(["prod", "start", "--preserve-logs"], { from: "user" });
    await program.parseAsync(["prod", "restart", "--preserve-logs"], { from: "user" });

    expect(readFileSync(stdoutLog, "utf8")).toBe("stdout");
    expect(readFileSync(stderrLog, "utf8")).toBe("stderr");
  });

  it("start and restart clear logs by default", async () => {
    const program = new Command();
    registerProdCommands(program);

    await program.parseAsync(["prod", "start"], { from: "user" });
    await program.parseAsync(["prod", "restart"], { from: "user" });

    expect(readFileSync(stdoutLog, "utf8")).toBe("");
    expect(readFileSync(stderrLog, "utf8")).toBe("");
  });

  it("prod start: errors when agent not loaded", async () => {
    mockSup.isAgentLoaded.mockReturnValue(false);
    const result = await runProdStart();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/(scripts\/deploy\.sh|scripts\\deploy\.ps1)/);
  });

  it("prod start: clears marker and kickstarts when agent loaded", async () => {
    mockSup.isAgentLoaded.mockReturnValue(true);
    writeMarker({
      devPid: 1,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: true,
      shimVersion: 1,
    });
    const result = await runProdStart();
    expect(result.ok).toBe(true);
    expect(mockSup.kickstartAgent).toHaveBeenCalled();
    // Marker should be gone.
    const { readMarker } = await import("../../src/lifecycle/marker");
    expect(readMarker()).toBeNull();
  });

  it("prod stop: bootouts the agent", async () => {
    const result = await runProdStop();
    expect(result.ok).toBe(true);
    expect(mockSup.bootoutAgent).toHaveBeenCalled();
  });

  it("prod status: returns running state", async () => {
    const status = await runProdStatus();
    expect(status.agentLoaded).toBe(true);
    expect(status.agentPid).toBe(12345);
    expect(status.marker).toBeNull();
  });

  it("prod status: reports marker when present", async () => {
    writeMarker({
      devPid: 1,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: true,
      shimVersion: 1,
    });
    const status = await runProdStatus();
    expect(status.marker?.userHeld).toBe(true);
  });

  it("prod doctor: detects + repairs stale marker (dead PID, not userHeld)", async () => {
    writeMarker({
      devPid: 999999,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1,
    });
    const report = await runProdDoctor({ fix: true });
    expect(report.repairs).toContain("cleared stale marker (dev pid 999999 was dead)");
    const { readMarker } = await import("../../src/lifecycle/marker");
    expect(readMarker()).toBeNull();
  });

  describe("prod logs", () => {
    it("follows both stdout and stderr by default with seed lines", async () => {
      const spawnTail = vi.fn().mockResolvedValue({ ok: true });
      const result = await runProdLogs(
        { lines: 50, follow: true, errorsOnly: false },
        { spawnTail },
      );
      expect(result.ok).toBe(true);
      expect(spawnTail).toHaveBeenCalledOnce();
      const [callArgs] = spawnTail.mock.calls[0];
      expect(callArgs.files).toEqual([stdoutLog, stderrLog]);
      expect(callArgs.follow).toBe(true);
      expect(callArgs.lines).toBe(50);
    });

    it("--errors-only tails only stderr", async () => {
      const spawnTail = vi.fn().mockResolvedValue({ ok: true });
      await runProdLogs({ lines: 50, follow: true, errorsOnly: true }, { spawnTail });
      const [callArgs] = spawnTail.mock.calls[0];
      expect(callArgs.files).toEqual([stderrLog]);
    });

    it("--no-follow passes follow=false to the spawner", async () => {
      const spawnTail = vi.fn().mockResolvedValue({ ok: true });
      await runProdLogs({ lines: 20, follow: false, errorsOnly: false }, { spawnTail });
      const [callArgs] = spawnTail.mock.calls[0];
      expect(callArgs.follow).toBe(false);
      expect(callArgs.lines).toBe(20);
    });

    it("returns ok=false with a clear message when neither log file exists", async () => {
      // When both paths point at non-existent files, the spawner should refuse
      // and runProdLogs should turn that into a CommandResult, not a crash.
      const spawnTail = vi.fn().mockResolvedValue({ ok: false, message: "no log files found" });
      const result = await runProdLogs(
        { lines: 50, follow: true, errorsOnly: false },
        { spawnTail },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no log files/);
    });

    it("--clear truncates both log files in place and skips tail", async () => {
      const spawnTail = vi.fn();
      const truncated: string[] = [];
      const truncate = (file: string) => {
        truncated.push(file);
      };
      const result = await runProdLogs(
        { lines: 50, follow: false, errorsOnly: false, clear: true },
        { spawnTail, truncate },
      );
      expect(result.ok).toBe(true);
      expect(spawnTail).not.toHaveBeenCalled();
      expect(truncated).toEqual([stdoutLog, stderrLog]);
      expect(result.message).toMatch(/cleared:/);
    });

    it("--clear returns ok=false if truncate throws", async () => {
      const spawnTail = vi.fn();
      const truncate = () => {
        throw new Error("EACCES");
      };
      const result = await runProdLogs(
        { lines: 50, follow: false, errorsOnly: false, clear: true },
        { spawnTail, truncate },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/failed to truncate.*EACCES/);
    });
  });

  it("prod doctor: reports without fixing when fix=false", async () => {
    writeMarker({
      devPid: 999999,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1,
    });
    const report = await runProdDoctor({ fix: false });
    expect(report.findings).toContain("stale marker (dev pid 999999 dead)");
    const { readMarker } = await import("../../src/lifecycle/marker");
    expect(readMarker()).not.toBeNull();
  });
});
