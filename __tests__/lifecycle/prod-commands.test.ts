import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProdDoctor, runProdStart, runProdStatus, runProdStop } from "../../cli/prod";
import { writeMarker } from "../../src/lifecycle/marker";

const mockSup = {
  isAgentLoaded: vi.fn(() => true),
  bootoutAgent: vi.fn(),
  bootstrapAgent: vi.fn(),
  kickstartAgent: vi.fn(),
  getAgentPid: vi.fn(() => 12345 as number | null),
};

vi.mock("../../src/lifecycle/platform", () => ({
  getSupervisor: () => mockSup,
}));

describe("prod commands", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prod-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
    vi.clearAllMocks();
    // Reset defaults that clearAllMocks wipes
    mockSup.isAgentLoaded.mockReturnValue(true);
    mockSup.getAgentPid.mockReturnValue(12345);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
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
