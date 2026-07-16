import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { installDir } from "../../lifecycle/constants";
import { getLogger } from "../../logger";

const logger = getLogger("logs-api");

type LogSource = "stdout" | "stderr" | "dev";

function resolveLogPath(source: LogSource): string {
  return join(installDir(), "logs", `${source}.log`);
}

function pickDefaultSource(): LogSource {
  // Prefer live prod stdout when present and non-empty; fall back to stderr/dev.
  for (const source of ["stdout", "stderr", "dev"] as const) {
    const p = resolveLogPath(source);
    if (existsSync(p) && statSync(p).size > 0) return source;
  }
  return "stdout";
}

/** Read the last `limit` non-empty content lines starting after `since` line index. */
function readLogLines(
  filePath: string,
  sinceOffset: number,
  limit: number,
): { lines: string[]; offset: number; total: number } {
  if (!existsSync(filePath)) {
    return { lines: [], offset: 0, total: 0 };
  }

  const fd = openSync(filePath, "r");
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return { lines: [], offset: 0, total: 0 };

    // Cap read window so huge stdout.log (100MB+) stays responsive.
    const maxBytes = Math.min(size, 2 * 1024 * 1024);
    const start = size - maxBytes;
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const firstNl = text.indexOf("\n");
      if (firstNl >= 0) text = text.slice(firstNl + 1);
    }

    const allLines = text.split("\n").filter((line) => line.trim() && !line.startsWith("==="));

    let lines: string[];
    let newOffset: number;

    if (sinceOffset > 0 && sinceOffset < allLines.length) {
      lines = allLines.slice(sinceOffset, sinceOffset + limit);
      newOffset = sinceOffset + lines.length;
    } else if (sinceOffset >= allLines.length && sinceOffset > 0) {
      lines = [];
      newOffset = allLines.length;
    } else {
      lines = allLines.slice(-limit);
      newOffset = allLines.length;
    }

    return { lines, offset: newOffset, total: allLines.length };
  } finally {
    closeSync(fd);
  }
}

export function createLogsRoutes() {
  const app = new Hono();

  app.get("/", (c) => {
    try {
      const sourceParam = (c.req.query("source") || "").toLowerCase();
      const source: LogSource =
        sourceParam === "stdout" || sourceParam === "stderr" || sourceParam === "dev"
          ? sourceParam
          : pickDefaultSource();

      const logPath = resolveLogPath(source);
      const sinceOffset = parseInt(c.req.query("since") || "0", 10);
      const limit = Math.min(parseInt(c.req.query("limit") || "100", 10) || 100, 1000);

      if (!existsSync(logPath)) {
        return c.json({
          logs: [],
          message: `No log file found for source=${source}`,
          offset: 0,
          total: 0,
          source,
        });
      }

      const { lines, offset, total } = readLogLines(logPath, sinceOffset, limit);
      const stats = statSync(logPath);

      return c.json({
        logs: lines,
        offset,
        total,
        hasMore: offset < total,
        source,
        fileSize: stats.size,
        fileModified: stats.mtime.toISOString(),
      });
    } catch (error) {
      logger.error("Failed to read logs", { error: String(error) });
      return c.json(
        {
          error: "Failed to read logs",
          logs: [],
          offset: 0,
          total: 0,
        },
        500,
      );
    }
  });

  app.get("/meta", (c) => {
    try {
      const sources = (["stdout", "stderr", "dev"] as const).map((source) => {
        const logPath = resolveLogPath(source);
        if (!existsSync(logPath)) {
          return { source, exists: false, total: 0, fileSize: 0 };
        }
        const stats = statSync(logPath);
        return {
          source,
          exists: true,
          fileSize: stats.size,
          fileModified: stats.mtime.toISOString(),
        };
      });

      return c.json({
        defaultSource: pickDefaultSource(),
        sources,
      });
    } catch (error) {
      logger.error("Failed to read log metadata", { error: String(error) });
      return c.json({ error: "Failed to read log metadata", exists: false }, 500);
    }
  });

  return app;
}
