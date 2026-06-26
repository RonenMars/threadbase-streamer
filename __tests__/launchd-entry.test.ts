import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../src/lifecycle/marker");
vi.mock("../src/lifecycle/process-liveness");

import { decideShimAction } from "../cli/launchd-entry";
import { readMarker, clearMarker } from "../src/lifecycle/marker";
import { isPidAlive } from "../src/lifecycle/process-liveness";

const mockReadMarker = vi.mocked(readMarker);
const mockIsPidAlive = vi.mocked(isPidAlive);
const mockClearMarker = vi.mocked(clearMarker);

const MARKER = {
  devPid: 1234,
  port: 8766,
  repoToplevel: "/tmp/repo",
  suspendedAt: new Date().toISOString(),
  userHeld: false,
  shimVersion: 1 as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});

describe("decideShimAction", () => {
  it("executes when no marker exists", () => {
    mockReadMarker.mockReturnValue(null);
    expect(decideShimAction()).toEqual({ kind: "exec" });
  });

  it("exits when dev PID is alive and not userHeld", () => {
    mockReadMarker.mockReturnValue({ ...MARKER, userHeld: false });
    mockIsPidAlive.mockReturnValue(true);
    expect(decideShimAction()).toEqual({ kind: "exit", reason: "dev-alive" });
  });

  it("exits when dev PID is alive and userHeld", () => {
    mockReadMarker.mockReturnValue({ ...MARKER, userHeld: true });
    mockIsPidAlive.mockReturnValue(true);
    expect(decideShimAction()).toEqual({ kind: "exit", reason: "user-held" });
  });

  it("auto-restores when dev PID is dead (userHeld=false)", () => {
    mockReadMarker.mockReturnValue({ ...MARKER, userHeld: false });
    mockIsPidAlive.mockReturnValue(false);
    expect(decideShimAction()).toEqual({ kind: "exec", reason: "crash-recovery" });
    expect(mockClearMarker).toHaveBeenCalledOnce();
  });

  it("auto-restores when dev PID is dead even if userHeld=true (stale marker)", () => {
    mockReadMarker.mockReturnValue({ ...MARKER, userHeld: true });
    mockIsPidAlive.mockReturnValue(false);
    expect(decideShimAction()).toEqual({ kind: "exec", reason: "crash-recovery" });
    expect(mockClearMarker).toHaveBeenCalledOnce();
  });
});
