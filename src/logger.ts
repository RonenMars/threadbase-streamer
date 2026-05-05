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
    debug: (m, f, d = "both") => emit(pinoChild, "debug", m, f, d),
    info: (m, f, d = "both") => emit(pinoChild, "info", m, f, d),
    warn: (m, f, d = "both") => emit(pinoChild, "warn", m, f, d),
    error: (m, f, d = "both") => emit(pinoChild, "error", m, f, d),
    log: (lvl, m, f, d = "both") => emit(pinoChild, lvl, m, f, d),
    pino: pinoChild,
  };
}

export function getLogger(component?: string): Logger {
  return build(component ? baseLogger.child({ component }) : baseLogger);
}

export const logger: Logger = build(baseLogger);
