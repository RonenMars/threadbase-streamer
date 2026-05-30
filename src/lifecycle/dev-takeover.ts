import { createServer } from "node:net";
import { getLogger } from "../logger";
import { bootoutAgent, isAgentLoaded } from "./launchd";
import { readMarker, writeMarker } from "./marker";
import { forgetAll, forgetRepo, getPrefForRepo, writePrefForRepo } from "./prefs";
import type { PromptFn } from "./prompt";

const log = getLogger("lifecycle.dev-takeover");

export type DevPlan = { kind: "use-port"; port: number } | { kind: "replace-prod"; port: number };

export type ResolveDevPlanOpts = {
  requestedPort: number;
  replaceProd: boolean;
  forget: boolean;
  forgetAll: boolean;
  repoToplevel: string | null;
  isProdActive: () => boolean;
  portInUse: (port: number) => boolean;
  prompt: PromptFn;
  findFreePort: (start: number) => Promise<number>;
};

export async function resolveDevPlan(opts: ResolveDevPlanOpts): Promise<DevPlan> {
  if (opts.forgetAll) forgetAll();
  if (opts.forget && opts.repoToplevel) forgetRepo(opts.repoToplevel);

  // Explicit flag overrides everything.
  if (opts.replaceProd) {
    return { kind: "replace-prod", port: opts.requestedPort };
  }

  const prodActive = opts.isProdActive();
  const portTaken = opts.portInUse(opts.requestedPort);
  if (!prodActive && !portTaken) {
    return { kind: "use-port", port: opts.requestedPort };
  }

  // Conflict path. Honour remembered choice if not --forget.
  if (!opts.forget) {
    const pref = getPrefForRepo(opts.repoToplevel);
    if (pref) {
      if (pref.choice === "replace-prod") {
        return { kind: "replace-prod", port: opts.requestedPort };
      }
      if (pref.choice === "use-port" && pref.port) {
        return { kind: "use-port", port: pref.port };
      }
    }
  }

  const suggested = await opts.findFreePort(opts.requestedPort + 1);
  const answer = await opts.prompt({ prodPort: opts.requestedPort, suggestedAltPort: suggested });

  if (answer.remember && opts.repoToplevel) {
    if (answer.choice === "replace-prod") {
      writePrefForRepo(opts.repoToplevel, { choice: "replace-prod" });
    } else {
      writePrefForRepo(opts.repoToplevel, { choice: "use-port", port: answer.port });
    }
  }

  return answer.choice === "replace-prod"
    ? { kind: "replace-prod", port: opts.requestedPort }
    : { kind: "use-port", port: answer.port };
}

// Real I/O helpers used by cli/index.ts; kept here so they're collocated.
export function detectProdActive(): boolean {
  return isAgentLoaded();
}

export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}

export function findFreePort(start: number): Promise<number> {
  return tryBind(start, 0);
}

async function tryBind(start: number, offset: number): Promise<number> {
  if (offset >= 50) return start;
  const port = start + offset;
  const free = await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
  if (free) return port;
  return tryBind(start, offset + 1);
}

/**
 * Acquire the prod port from launchd. Writes marker, unloads agent, installs
 * signal handlers that flip userHeld=true on clean exit (so launchd's shim
 * stays out until `tb-streamer prod start`).
 */
export function takeoverProd(opts: { port: number; repoToplevel: string | null }): void {
  const existing = readMarker();
  if (existing) {
    throw new Error(
      `prod is already suspended by dev pid ${existing.devPid} (since ${existing.suspendedAt}). ` +
        `Stop that dev session first, or run 'tb-streamer prod doctor'.`,
    );
  }

  bootoutAgent();
  writeMarker({
    devPid: process.pid,
    port: opts.port,
    repoToplevel: opts.repoToplevel ?? "(no-repo)",
    suspendedAt: new Date().toISOString(),
    userHeld: false,
    shimVersion: 1,
  });

  const flipUserHeld = () => {
    const m = readMarker();
    if (m && m.devPid === process.pid) {
      writeMarker({ ...m, userHeld: true });
      log.info(
        `prod is suspended (userHeld). Run 'tb-streamer prod start' to restore the supervised instance.`,
      );
    }
  };

  process.on("SIGINT", () => {
    flipUserHeld();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    flipUserHeld();
    process.exit(0);
  });
  process.on("SIGHUP", () => {
    flipUserHeld();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    flipUserHeld();
    log.error(`uncaught: ${err.message}`);
    process.exit(1);
  });
  process.on("exit", () => {
    flipUserHeld();
  });
}
