import pino, { type Logger as PinoLogger } from "pino";

export type LogDest = "console" | "pino" | "both";
export type LogLevel = "debug" | "info" | "warn" | "error";

const baseLogger: PinoLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "tb-streamer" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]'],
    censor: "[redacted]",
  },
});

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>, dest?: LogDest): void;
  info(msg: string, fields?: Record<string, unknown>, dest?: LogDest): void;
  warn(msg: string, fields?: Record<string, unknown>, dest?: LogDest): void;
  error(msg: string, fields?: Record<string, unknown>, dest?: LogDest): void;
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>, dest?: LogDest): void;
  pino: PinoLogger;
}

/**
 * Where a line goes when the caller doesn't pass an explicit `dest`.
 *
 * Under a supervisor (launchd, systemd, Task Scheduler, Docker) fd 1 is a file
 * or a pipe. There the console half of the old `"both"` default was an
 * unstructured duplicate of the pino line — and because `console` has no level
 * of its own, it also printed every `debug` call pino had already filtered out.
 * Those two effects were ~40% of a 261 MB stdout.log, the single loudest line
 * being a `debug` one that could not be turned off by any setting.
 *
 * At a human terminal the tradeoff inverts: the pretty line is the useful one
 * and the JSON is the noise. An explicit `dest` still overrides both cases,
 * which is what the CLI's user-facing output (banners, QR, `prod doctor`) uses.
 */
function defaultDest(): LogDest {
  return process.stdout.isTTY ? "console" : "pino";
}

function emit(
  pinoChild: PinoLogger,
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> | undefined,
  dest: LogDest,
): void {
  if (dest === "pino" || dest === "both") {
    if (fields && Object.keys(fields).length > 0) pinoChild[level](fields, msg);
    else pinoChild[level](msg);
  }
  if (dest === "console" || dest === "both") {
    const consoleMethod: "log" | "warn" | "error" =
      level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[consoleMethod](msg);
  }
}

function build(pinoChild: PinoLogger): Logger {
  return {
    debug: (m, f, d = defaultDest()) => emit(pinoChild, "debug", m, f, d),
    info: (m, f, d = defaultDest()) => emit(pinoChild, "info", m, f, d),
    warn: (m, f, d = defaultDest()) => emit(pinoChild, "warn", m, f, d),
    error: (m, f, d = defaultDest()) => emit(pinoChild, "error", m, f, d),
    log: (lvl, m, f, d = defaultDest()) => emit(pinoChild, lvl, m, f, d),
    pino: pinoChild,
  };
}

export function getLogger(component?: string): Logger {
  return build(component ? baseLogger.child({ component }) : baseLogger);
}

export const logger: Logger = build(baseLogger);
