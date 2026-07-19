export interface RestartHealthOptions {
  port: number;
  expectedVersion: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function isExpectedVersion(actual: string, expected: string): boolean {
  return actual === expected || actual.startsWith(`${expected}+`);
}

/**
 * Waits until the process actually serving the streamer port reports the
 * activated version. This deliberately reads /healthz instead of version.txt:
 * the sidecar describes the files on disk, not necessarily the live process.
 */
export async function waitForRestartHealth(opts: RestartHealthOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "server did not respond";

  while (Date.now() <= deadline) {
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), Math.min(2_000, timeoutMs));
    try {
      const response = await fetch(`http://127.0.0.1:${opts.port}/healthz`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const body = (await response.json()) as { ok?: unknown; version?: unknown };
        if (body.ok === true && typeof body.version === "string") {
          if (isExpectedVersion(body.version, opts.expectedVersion)) return;
          lastFailure = `running version is ${body.version}, expected ${opts.expectedVersion}`;
        } else {
          lastFailure = "health response is missing ok/version";
        }
      } else {
        lastFailure = `health endpoint returned ${response.status}`;
      }
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(requestTimer);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }

  throw new Error(`restart verification failed: ${lastFailure}`);
}
