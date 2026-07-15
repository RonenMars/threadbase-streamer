import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
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
        return c.json({ logs: [], message: "No log file found" });
      }
      
      const content = readFileSync(logPath, "utf8");
      const lines = content.split("\n").filter(line => line.trim() && !line.startsWith("==="));
      
      const lastN = parseInt(c.req.query("limit") || "100", 10);
      const recentLines = lines.slice(-lastN);
      
      return c.json({ 
        logs: recentLines,
        count: recentLines.length,
        total: lines.length
      });
    } catch (error) {
      logger.error("Failed to read logs", { error: String(error) });
      return c.json({ error: "Failed to read logs", logs: [] }, 500);
    }
  });
  
  return app;
}
