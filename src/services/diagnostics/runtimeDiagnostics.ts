import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Logger } from "../../logger";

/** Count descriptors only; never collect or log file names. null means unavailable. */
export async function readOpenFileCount(
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  try {
    if (platform === "linux") return (await readdir("/proc/self/fd")).length;
    if (platform === "darwin") {
      return await new Promise<number | null>((resolve) => {
        execFile(
          "/usr/sbin/lsof",
          ["-nP", "-a", "-p", String(process.pid), "-Ff"],
          { encoding: "utf8", timeout: 2_000, maxBuffer: 1_048_576 },
          (error, stdout) => {
            resolve(error ? null : stdout.split("\n").filter((line) => /^f\d+$/.test(line)).length);
          },
        );
      });
    }
  } catch {
    // Resource exhaustion can also prevent the diagnostic probe from running.
  }
  return null;
}

/** One numeric log per minute, independent of app connections and pressure transitions. */
export function startRuntimeDiagnostics(
  log: Pick<Logger, "info">,
  readFiles: () => Promise<number | null> = readOpenFileCount,
): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let stopped = false;
  let pending = false;
  const timer = setInterval(() => {
    if (pending) return;
    const eventLoopP99Ms = histogram.percentile(99) / 1e6;
    const eventLoopMaxMs = histogram.max / 1e6;
    histogram.reset();
    pending = true;
    void readFiles().then((openFileCount) => {
      pending = false;
      if (stopped) return;
      log.info(
        "Runtime diagnostics",
        { event: "runtime.sample", eventLoopP99Ms, eventLoopMaxMs, openFileCount },
        "pino",
      );
    });
  }, 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    histogram.disable();
  };
}
