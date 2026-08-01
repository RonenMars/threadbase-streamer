import { spawn } from "node:child_process";
import type { HostTransport } from "./protocol";
import { connectToHost, hostSocketPath } from "./socket";

/**
 * Start a pty-host, or attach to the one already running (plan Phase 6b).
 *
 * The streamer calls this at boot when the `ptyHost` feature flag is enabled.
 */

/** How long to wait for a freshly-spawned host to accept a connection. */
const HOST_READY_TIMEOUT_MS = 5_000;
const HOST_POLL_INTERVAL_MS = 50;

export interface SpawnHostOptions {
  instanceId: string;
  /** argv[1] for the child — the CLI entry point. Defaults to this process's. */
  entryPoint?: string;
  timeoutMs?: number;
}

/**
 * Connect to the host for this instance, spawning it if none is listening.
 *
 * Attach-first rather than spawn-first: the host outliving the streamer is the
 * feature, so the common case after a restart is that one is already there.
 */
export async function connectOrSpawnHost(options: SpawnHostOptions): Promise<HostTransport> {
  const socketPath = hostSocketPath(options.instanceId);

  try {
    return await connectToHost(socketPath);
  } catch {
    // Nothing listening — ours to start.
  }

  spawnDetachedHost(socketPath, options.entryPoint);

  // Poll rather than wait on a ready signal: the child's stdio is discarded, so
  // there is no channel to signal on. The socket accepting a connection is the
  // only readiness fact that actually matters to the caller.
  const deadline = Date.now() + (options.timeoutMs ?? HOST_READY_TIMEOUT_MS);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectToHost(socketPath);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, HOST_POLL_INTERVAL_MS));
    }
  }
  throw new Error(
    `pty-host did not accept a connection on ${socketPath} within ${options.timeoutMs ?? HOST_READY_TIMEOUT_MS}ms` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}

/**
 * Spawn the host so it survives this process.
 *
 * Three properties, each load-bearing:
 *
 *  - `detached` puts it in its own process group, so a Ctrl-C or a group kill
 *    aimed at the streamer does not take the agents with it.
 *  - `stdio: "ignore"` means it holds none of our descriptors. A child that
 *    inherited our stdout keeps a pipe open that the parent's exit cannot
 *    close, and on POSIX would also receive our terminal's SIGHUP — which is
 *    precisely the hangup this whole feature exists to avoid.
 *  - `unref()` removes it from our event loop, so the streamer can exit while
 *    the host keeps running.
 */
export function spawnDetachedHost(socketPath: string, entryPoint?: string): void {
  const child = spawn(
    process.execPath,
    [entryPoint ?? process.argv[1], "pty-host", "--socket", socketPath],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}
