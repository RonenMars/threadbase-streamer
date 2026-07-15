import { Hono } from "hono";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { installDir } from "../../lifecycle/constants";
import { getLogger } from "../../logger";

const logger = getLogger("logs-api");

export function createLogsRoutes() {
  const app = new Hono();
  
  app.get("/", (c) => {
    try {
      const logPath = join(installDir(), "logs", "dev.log");
      
      if (!existsSync(logPath)) {
        return c.json({ 
          logs: [], 
          message: "No log file found",
          offset: 0,
          total: 0
        });
      }
      
      const content = readFileSync(logPath, "utf8");
      const allLines = content.split("\n").filter(line => line.trim() && !line.startsWith("==="));
      
      // Get query parameters
      const sinceOffset = parseInt(c.req.query("since") || "0", 10);
      const limit = parseInt(c.req.query("limit") || "100", 10);
      
      let lines: string[];
      let newOffset: number;
      
      if (sinceOffset > 0 && sinceOffset < allLines.length) {
        // Fetch logs from the specified offset (incremental update)
        lines = allLines.slice(sinceOffset, sinceOffset + limit);
        newOffset = sinceOffset + lines.length;
      } else if (sinceOffset >= allLines.length) {
        // Client is up to date, no new logs
        lines = [];
        newOffset = allLines.length;
      } else {
        // Initial fetch: return last N logs
        lines = allLines.slice(-limit);
        newOffset = allLines.length;
      }
      
      const stats = statSync(logPath);
      
      return c.json({ 
        logs: lines,
        offset: newOffset,
        total: allLines.length,
        hasMore: newOffset < allLines.length,
        fileSize: stats.size,
        fileModified: stats.mtime.toISOString()
      });
    } catch (error) {
      logger.error("Failed to read logs", { error: String(error) });
      return c.json({ 
        error: "Failed to read logs", 
        logs: [],
        offset: 0,
        total: 0
      }, 500);
    }
  });
  
  // Endpoint to get log file metadata without reading content
  app.get("/meta", (c) => {
    try {
      const logPath = join(installDir(), "logs", "dev.log");
      
      if (!existsSync(logPath)) {
        return c.json({ 
          exists: false,
          total: 0
        });
      }
      
      const content = readFileSync(logPath, "utf8");
      const allLines = content.split("\n").filter(line => line.trim() && !line.startsWith("==="));
      const stats = statSync(logPath);
      
      return c.json({
        exists: true,
        total: allLines.length,
        fileSize: stats.size,
        fileModified: stats.mtime.toISOString()
      });
    } catch (error) {
      logger.error("Failed to read log metadata", { error: String(error) });
      return c.json({ error: "Failed to read log metadata", exists: false }, 500);
    }
  });
  
  return app;
}
