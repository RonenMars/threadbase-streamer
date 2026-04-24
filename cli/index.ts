import "dotenv/config";
import { Command } from "commander";
import { loadOrCreateApiKey } from "../src/auth";
import { StreamerServer } from "../src/server";

const program = new Command();

program
  .name("threadbase-streamer")
  .description("PTY session management, WebSocket streaming, and REST API server for Claude Code")
  .version("0.1.0");

program
  .command("serve")
  .description("Start the streamer server")
  .option("-p, --port <number>", "Port to listen on", "3456")
  .option("--api-key <key>", "API key for authentication")
  .option("--local-no-auth", "Skip auth for localhost requests", false)
  .option("-v, --verbose", "Verbose output", false)
  .option("--browse-root <path>", "Root directory for file browsing")
  .action(async (opts) => {
    const port = Number.parseInt(opts.port, 10);
    const apiKey = opts.apiKey ?? loadOrCreateApiKey();

    const server = new StreamerServer({
      port,
      apiKey,
      localNoAuth: opts.localNoAuth,
      verbose: opts.verbose,
      browseRoot: opts.browseRoot,
    });

    await server.listen(port);

    console.log(`\nThreadbase Streamer v0.1.0`);
    console.log(`Listening on http://localhost:${port}`);
    console.log(`WebSocket at ws://localhost:${port}/ws`);
    console.log(`API key: ${apiKey}\n`);

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\nShutting down...");
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
