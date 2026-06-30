import "dotenv/config";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import { loadOrCreateApiKey, loadPublicUrl } from "../src/auth";
import { loadUpdateConfig, UPDATE_CONFIG_PATH } from "../src/config/update-config";
import { appendDevSessionMarker } from "../src/devLog";
import { resolveServerUrl } from "../src/lan-url";
import { getLogger } from "../src/logger";
import { StreamerServer } from "../src/server";
import { checkForUpdate } from "../src/updater/check-update";
import { runInstall } from "../src/updater/install";
import { appendUpdateLog } from "../src/updater/update-log";
import { getVersion } from "../src/version";
import { registerProdCommands } from "./prod";

const log = getLogger("cli");

const program = new Command();

program
  .name("threadbase-streamer")
  .description("PTY session management, WebSocket streaming, and REST API server for Claude Code")
  .version(getVersion());

program
  .command("serve")
  .description("Start the streamer server")
  .option("-p, --port <number>", "Port to listen on", "8766")
  .option("--api-key <key>", "API key for authentication")
  .option("--local-no-auth", "Skip auth for localhost requests", false)
  .option("-v, --verbose", "Verbose output", false)
  .option("--log-menubar-requests", "Log /healthz requests from the menubar app", false)
  .option("--browse-root <path>", "Root directory for file browsing")
  .option(
    "--public-url <url>",
    "Public URL clients should use to reach this server (https:// required, except localhost). Falls back to THREADBASE_PUBLIC_URL env or public_url: in ~/.threadbase/server.yaml.",
  )
  .option("--no-pair-qr", "Skip the pairing QR on startup", false)
  .option("--replace-prod", "Stop the launchd-supervised prod streamer and bind its port", false)
  .option("--forget", "Clear this repo's remembered dev-vs-prod choice and re-prompt", false)
  .option("--forget-all", "Clear every repo's remembered dev-vs-prod choice", false)
  .option(
    "--prod",
    "Run as if invoked by launchd: skip the dev-takeover prompt and signal handlers",
    false,
  )
  .option(
    "--multi-agent-flow",
    "Run in multi-agent mode (PTY mode unreachable in this process)",
    false,
  )
  .action(async (opts) => {
    if (opts.multiAgentFlow) {
      process.env.MULTI_AGENT_FLOW = "true";
    }
    const requestedPort = Number.parseInt(opts.port, 10);
    const apiKey = opts.apiKey ?? loadOrCreateApiKey();
    const publicUrl = opts.publicUrl ?? loadPublicUrl() ?? null;

    // Detect whether this invocation is "dev mode" (started by a human shell)
    // or "prod mode" (started by launchd). PPID 1 = launchd on macOS.
    const isProdInvocation = opts.prod === true || process.ppid === 1;
    if (!isProdInvocation) appendDevSessionMarker();

    let resolvedPort = requestedPort;

    if (!isProdInvocation) {
      const { resolveDevPlan, detectProdActive, isPortInUse, findFreePort, takeoverProd } =
        await import("../src/lifecycle/dev-takeover");
      const { interactivePrompt } = await import("../src/lifecycle/prompt");
      const { getGitToplevel } = await import("../src/lifecycle/repo");

      const repoToplevel = getGitToplevel(process.cwd());
      const portTaken = await isPortInUse(requestedPort);

      const plan = await resolveDevPlan({
        requestedPort,
        replaceProd: opts.replaceProd === true,
        forget: opts.forget === true,
        forgetAll: opts.forgetAll === true,
        repoToplevel,
        isProdActive: detectProdActive,
        portInUse: () => portTaken,
        prompt: interactivePrompt,
        findFreePort,
      });

      resolvedPort = plan.port;
      if (plan.kind === "replace-prod") {
        takeoverProd({ port: plan.port, repoToplevel });
      }
    }

    const server = new StreamerServer({
      port: resolvedPort,
      apiKey,
      apiKeySource: opts.apiKey ? "cli" : "config",
      localNoAuth: opts.localNoAuth,
      verbose: opts.verbose,
      logMenubarRequests: opts.logMenubarRequests,
      browseRoot: opts.browseRoot,
      publicUrl: opts.publicUrl,
    });

    await server.listen(resolvedPort);

    {
      const v = getVersion();
      log.info(`Threadbase Streamer v${v}`, { version: v, port: resolvedPort });
    }
    log.info(`Listening on http://localhost:${resolvedPort}`, {
      url: `http://localhost:${resolvedPort}`,
    });
    log.info(`WebSocket at ws://localhost:${resolvedPort}/ws`, {
      wsUrl: `ws://localhost:${resolvedPort}/ws`,
    });
    log.info(`API key: ${apiKey}`, { apiKeyMasked: `${apiKey.slice(0, 6)}…` });

    if (opts.pairQr !== false) {
      try {
        await printPairQR({ port: resolvedPort, apiKey, publicUrl });
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

    if (isProdInvocation) {
      // Prod mode: simple shutdown handlers (no takeover semantics).
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // Belt-and-suspenders for unhandled socket errors that slip past the
      // specific guards in StreamerServer (clientError, server-error, upgrade
      // race). Without this handler, an unhandled 'error' event from any TCP
      // socket terminates the process with a stack trace to stderr; launchd
      // respawns it but the next startup repeats the same warm-up. Logging
      // the error with the cause + exiting 1 ensures launchd respawns
      // cleanly AND we can grep the log for what slipped through.
      process.on("uncaughtException", (err) => {
        log.error(`uncaught: ${err.message}`, {
          error: err.message,
          stack: err.stack,
          event: "process.uncaught",
        });
        process.exit(1);
      });
      process.on("unhandledRejection", (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        log.error(`unhandled rejection: ${msg}`, {
          error: msg,
          event: "process.unhandled_rejection",
        });
        process.exit(1);
      });
    }
    // Dev mode with takeover already installed its handlers in takeoverProd().
    // Dev mode without takeover (use-port path) — install simple ones too:
    if (!isProdInvocation) {
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
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
  .option("-p, --port <number>", "Port the server is listening on", "8766")
  .action(async (opts) => {
    const port = Number.parseInt(opts.port, 10);
    const apiKey = loadOrCreateApiKey();
    const publicUrl = loadPublicUrl() ?? null;
    await printPairQR({ port, apiKey, publicUrl });
  });

program
  .command("set-key [key]")
  .description("Set the streamer API key in ~/.threadbase/server.yaml")
  .action(async (key: string | undefined) => {
    const { runSetKey } = await import("./setKey");
    const code = await runSetKey(
      { key },
      {
        log: {
          info: (msg) => console.log(msg),
          error: (msg) => console.error(msg),
        },
      },
    );
    process.exit(code);
  });

program
  .command("update")
  .description("Check for streamer updates from GitHub Releases and install them")
  .option("--check", "Check only; do not install", false)
  .option("--version <version>", "Pin to a specific release tag")
  .option("--allow-major", "Allow a major-version bump", false)
  .option("--force", "Skip the active-session defer check", false)
  .option("--dry-run", "Print what would be installed without writing to disk", false)
  .option("-p, --port <number>", "Port of the running streamer for active-session check", "8766")
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
          currentVersion: getVersion(),
          config: cfg,
          pinnedVersion: opts.version,
          allowMajor: opts.allowMajor,
        });
        appendUpdateLog(
          `[check] current=${result.current} latest=${result.latest ?? "none"} status=${result.reason}`,
        );
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
        currentVersion: getVersion(),
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
        case "unsupported-install":
          log.warn(result.reason, undefined, "console");
          process.exitCode = 2;
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
      appendUpdateLog(`[error] ${message}`);
      log.error(`Update failed: ${message}`, { error: message }, "console");
      process.exitCode = 1;
    }
  });

registerProdCommands(program);

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
