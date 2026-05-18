import "dotenv/config";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import { loadOrCreateApiKey, loadPublicUrl } from "../src/auth";
import { loadUpdateConfig, UPDATE_CONFIG_PATH } from "../src/config/update-config";
import { resolveServerUrl } from "../src/lan-url";
import { getLogger } from "../src/logger";
import { StreamerServer } from "../src/server";
import { checkForUpdate } from "../src/updater/check-update";
import { runInstall } from "../src/updater/install";

const log = getLogger("cli");

const program = new Command();

program
  .name("threadbase-streamer")
  .description("PTY session management, WebSocket streaming, and REST API server for Claude Code")
  .version(__VERSION__);

program
  .command("serve")
  .description("Start the streamer server")
  .option("-p, --port <number>", "Port to listen on", "3456")
  .option("--api-key <key>", "API key for authentication")
  .option("--local-no-auth", "Skip auth for localhost requests", false)
  .option("-v, --verbose", "Verbose output", false)
  .option("--browse-root <path>", "Root directory for file browsing")
  .option(
    "--public-url <url>",
    "Public URL clients should use to reach this server (https:// required, except localhost). Falls back to THREADBASE_PUBLIC_URL env or public_url: in ~/.threadbase/server.yaml.",
  )
  .option("--no-pair-qr", "Skip the pairing QR on startup", false)
  .action(async (opts) => {
    const port = Number.parseInt(opts.port, 10);
    const apiKey = opts.apiKey ?? loadOrCreateApiKey();
    const publicUrl = opts.publicUrl ?? loadPublicUrl() ?? null;

    const server = new StreamerServer({
      port,
      apiKey,
      localNoAuth: opts.localNoAuth,
      verbose: opts.verbose,
      browseRoot: opts.browseRoot,
      publicUrl: opts.publicUrl,
    });

    await server.listen(port);

    log.info(`Threadbase Streamer v${__VERSION__}`, { version: __VERSION__, port });
    log.info(`Listening on http://localhost:${port}`, { url: `http://localhost:${port}` });
    log.info(`WebSocket at ws://localhost:${port}/ws`, { wsUrl: `ws://localhost:${port}/ws` });
    log.info(`API key: ${apiKey}`, { apiKeyMasked: `${apiKey.slice(0, 6)}…` });

    if (opts.pairQr !== false) {
      try {
        await printPairQR({ port, apiKey, publicUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`(skipped pairing QR: ${message})`, { reason: message });
      }
    }

    const shutdown = async () => {
      log.info("Shutting down...");
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("cache")
  .description("Manage the local SQLite conversation cache")
  .addCommand(
    new Command("clear")
      .description("Delete the cache DB so it rebuilds from disk on next startup")
      .option(
        "--cache-dir <path>",
        "Cache directory (default: ~/.threadbase/cache)",
        `${process.env.HOME}/.threadbase/cache`,
      )
      .action((opts) => {
        const { rmSync, existsSync } = require("node:fs");
        const { join } = require("node:path");
        const dbPath = join(opts.cacheDir, "cache.db");
        for (const suffix of ["", "-shm", "-wal"]) {
          const f = dbPath + suffix;
          if (existsSync(f)) {
            rmSync(f);
            log.info(`Deleted ${f}`, { path: f }, "console");
          }
        }
        log.info("Cache cleared. Restart the server to rebuild.", undefined, "console");
      }),
  );

program
  .command("pair")
  .description("Print a pairing QR code (server must already be running)")
  .option("-p, --port <number>", "Port the server is listening on", "3456")
  .action(async (opts) => {
    const port = Number.parseInt(opts.port, 10);
    const apiKey = loadOrCreateApiKey();
    const publicUrl = loadPublicUrl() ?? null;
    await printPairQR({ port, apiKey, publicUrl });
  });

program
  .command("update")
  .description("Check for streamer updates from GitHub Releases and install them")
  .option("--check", "Check only; do not install", false)
  .option("--version <version>", "Pin to a specific release tag")
  .option("--allow-major", "Allow a major-version bump", false)
  .option("--force", "Skip the active-session defer check", false)
  .option("--dry-run", "Print what would be installed without writing to disk", false)
  .option("-p, --port <number>", "Port of the running streamer for active-session check", "3456")
  .action(async (opts) => {
    const cfg = loadUpdateConfig();
    if (!cfg) {
      log.warn(
        `No update config found at ${UPDATE_CONFIG_PATH}. Create one with at least 'github_repo: owner/name' to enable updates.`,
        undefined,
        "console",
      );
      process.exitCode = 1;
      return;
    }

    try {
      if (opts.check) {
        const result = await checkForUpdate({
          currentVersion: __VERSION__,
          config: cfg,
          pinnedVersion: opts.version,
          allowMajor: opts.allowMajor,
        });
        log.info(`Current : ${result.current}`, undefined, "console");
        log.info(`Latest  : ${result.latest ?? "(none)"}`, undefined, "console");
        log.info(`Channel : ${cfg.channel}`, undefined, "console");
        log.info(`Diff    : ${result.diff ?? "(none)"}`, undefined, "console");
        log.info(`Status  : ${result.reason}`, undefined, "console");
        return;
      }

      const port = Number.parseInt(opts.port, 10);
      const apiKey = loadOrCreateApiKey();

      const result = await runInstall({
        currentVersion: __VERSION__,
        config: cfg,
        pinnedVersion: opts.version,
        allowMajor: opts.allowMajor,
        force: opts.force,
        dryRun: opts.dryRun,
        runningServer: { port, apiKey },
      });

      switch (result.kind) {
        case "no-op":
          log.info(`Current : ${result.current}`, undefined, "console");
          log.info(`Latest  : ${result.latest ?? "(none)"}`, undefined, "console");
          log.info(`Status  : ${result.reason}`, undefined, "console");
          break;
        case "deferred":
          log.warn(`Deferred: ${result.reason}`, undefined, "console");
          process.exitCode = 2;
          break;
        case "dry-run":
          log.info(
            `Would install ${result.latest} from ${result.tarballUrl}`,
            undefined,
            "console",
          );
          break;
        case "installed":
          log.info(
            `Installed ${result.installed} (was ${result.previous}). Restart: ${result.restart.method}.`,
            undefined,
            "console",
          );
          if (result.pruned.length > 0) {
            log.info(`Pruned old releases: ${result.pruned.join(", ")}`, undefined, "console");
          }
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Update failed: ${message}`, { error: message }, "console");
      process.exitCode = 1;
    }
  });

program.parse();

async function printPairQR({
  port,
  apiKey,
  publicUrl,
}: {
  port: number;
  apiKey: string;
  publicUrl: string | null;
}): Promise<void> {
  const res = await fetch(`http://localhost:${port}/api/pair/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`/api/pair/start returned ${res.status}`);
  }
  const { token, expiresAt, expiresInSeconds } = (await res.json()) as {
    token: string;
    expiresAt: number;
    expiresInSeconds: number;
  };

  const url = resolveServerUrl({ publicUrl, port });
  const expSeconds = Math.floor(expiresAt / 1000);
  const payload = `threadbase://pair?url=${encodeURIComponent(url)}&token=${token}&exp=${expSeconds}`;

  log.info("Scan to pair a mobile client:\n", undefined, "console");
  qrcode.generate(payload, { small: true });
  log.info(`Server URL : ${url}`, undefined, "console");
  log.info(`Pair URL   : ${payload}`, undefined, "console");
  log.info(
    `Expires    : ${new Date(expiresAt).toLocaleTimeString()} (${expiresInSeconds}s)\n`,
    undefined,
    "console",
  );
}
