/**
 * Default test runs swallow StreamerServer pino JSON (http.request, boot
 * flags, cache_integrity, …). Vitest is not a TTY, so dest is "pino" and
 * every listen() dumps the production info stream into the reporter.
 *
 * Local default is silent. CI (`CI=true`) defaults to warn so a red job still
 * shows integrity / open-failed lines without the info flood. TEST_LOGS=1
 * restores the usual info stream. An explicit LOG_LEVEL always wins.
 */
export function resolveTestLogLevel(env: {
  TEST_LOGS?: string;
  LOG_LEVEL?: string;
  CI?: string;
}): string | undefined {
  const logsOn = env.TEST_LOGS === "1" || env.TEST_LOGS === "true";
  if (logsOn) return env.LOG_LEVEL;
  if (env.LOG_LEVEL !== undefined && env.LOG_LEVEL !== "") return env.LOG_LEVEL;
  return isCi(env.CI) ? "warn" : "silent";
}

function isCi(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const v = value.toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

const resolved = resolveTestLogLevel({
  TEST_LOGS: process.env.TEST_LOGS,
  LOG_LEVEL: process.env.LOG_LEVEL,
  CI: process.env.CI,
});
if (resolved !== undefined) process.env.LOG_LEVEL = resolved;
else delete process.env.LOG_LEVEL;
