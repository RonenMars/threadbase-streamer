import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readOpenFileCount,
  startRuntimeDiagnostics,
} from "../src/services/diagnostics/runtimeDiagnostics";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readdir: vi.fn() }));
vi.mock("node:perf_hooks", () => ({
  monitorEventLoopDelay: vi.fn(() => ({
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    percentile: vi.fn(() => 25_000_000),
    max: 900_000_000,
  })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("open file count", () => {
  it("counts only numeric descriptors from macOS lsof without requesting paths", async () => {
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args[3] as (error: Error | null, stdout: string) => void)(
        null,
        "p123\nfcwd\nftxt\nf0\nf1\nf42\n",
      );
      return {} as ReturnType<typeof execFile>;
    });
    expect(await readOpenFileCount("darwin")).toBe(3);
    expect(execFile).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", String(process.pid), "-Ff"],
      expect.objectContaining({ timeout: 2_000, maxBuffer: 1_048_576 }),
      expect.any(Function),
    );
  });

  it("uses proc on Linux and reports unavailable on failure or unsupported platforms", async () => {
    const { readdir } = await import("node:fs/promises");
    vi.mocked(readdir).mockResolvedValue(["0", "1", "2"] as never);
    expect(await readOpenFileCount("linux")).toBe(3);
    expect(readdir).toHaveBeenCalledWith("/proc/self/fd");
    vi.mocked(readdir).mockRejectedValue(new Error("EMFILE"));
    expect(await readOpenFileCount("linux")).toBeNull();
    expect(await readOpenFileCount("win32")).toBeNull();
  });

  it("reports unavailable if lsof fails", async () => {
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args[3] as (error: Error | null, stdout: string) => void)(new Error("timeout"), "");
      return {} as ReturnType<typeof execFile>;
    });
    expect(await readOpenFileCount("darwin")).toBeNull();
  });
});

describe("runtime diagnostics", () => {
  it("logs interval p99/max in milliseconds and file count, then releases resources", async () => {
    vi.useFakeTimers();
    const { monitorEventLoopDelay } = await import("node:perf_hooks");
    const info = vi.fn();
    const stop = startRuntimeDiagnostics({ info }, async () => 123);
    expect(info).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledWith(
      "Runtime diagnostics",
      {
        event: "runtime.sample",
        eventLoopP99Ms: 25,
        eventLoopMaxMs: 900,
        openFileCount: 123,
      },
      "pino",
    );
    const histogram = vi.mocked(monitorEventLoopDelay).mock.results.at(-1)?.value;
    expect(histogram.reset).toHaveBeenCalledOnce();
    stop();
    expect(histogram.disable).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledOnce();
  });

  it("does not overlap probes or log after shutdown while a probe is pending", async () => {
    vi.useFakeTimers();
    let finish!: (value: number | null) => void;
    const read = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          finish = resolve;
        }),
    );
    const info = vi.fn();
    const stop = startRuntimeDiagnostics({ info }, read);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledOnce();
    stop();
    finish(null);
    await Promise.resolve();
    expect(info).not.toHaveBeenCalled();
  });
});
