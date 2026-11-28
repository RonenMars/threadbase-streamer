import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { locateExecutable } from "../src/platform";
import {
  EXTERNAL_CONTROL_PLATFORMS,
  type ExternalControlConfig,
  externalControlConfigPath,
  readExternalControlConfig,
  writeExternalControlConfig,
} from "../src/services/external-control/config";
import {
  type ExternalControlGrant,
  MAX_GRANT_TTL_MS,
} from "../src/services/external-control/repository";
import type { ExternalBinding, ResolveResult } from "../src/services/external-control/resolver";
import { parseTmuxVersion, TMUX_MIN_VERSION, tmuxVersionSupported } from "../src/tmux/client";

/**
 * `tb-streamer external-control …`: the local half of Connect live. A grant
 * can only be made here, on the machine, by the user who owns the tmux server
 * — never over the API, and never for the shared API key.
 */

export interface ExternalControlCliLog {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

async function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export interface SetupDeps {
  log: ExternalControlCliLog;
  platform?: NodeJS.Platform;
  locate?: (exe: string) => string | null;
  tmuxVersion?: (tmuxPath: string) => Promise<string>;
  read?: () => ExternalControlConfig | null;
  write?: (c: ExternalControlConfig) => void;
}

export async function runExternalControlSetup(
  opts: { disable?: boolean; socket?: string[] },
  deps: SetupDeps,
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  if (!EXTERNAL_CONTROL_PLATFORMS.includes(platform)) {
    deps.log.error("Connect live supports macOS and Linux only.");
    return 1;
  }
  const write = deps.write ?? writeExternalControlConfig;
  const current = (deps.read ?? (() => readExternalControlConfig(platform)))();
  if (opts.disable) {
    write({ enabled: false, tmuxPath: current?.tmuxPath ?? "", sockets: current?.sockets ?? [] });
    deps.log.info("Connect live disabled. Running agents are not affected.");
    return 0;
  }
  const tmuxPath = (deps.locate ?? locateExecutable)("tmux");
  if (!tmuxPath) {
    deps.log.error("tmux not found on PATH. Nothing is installed automatically.");
    return 1;
  }
  const version = deps.tmuxVersion ? await deps.tmuxVersion(tmuxPath).catch(() => "") : "";
  if (deps.tmuxVersion && !tmuxVersionSupported(parseTmuxVersion(version))) {
    deps.log.error(
      `tmux ${version.trim() || "(unknown version)"} is too old; ${TMUX_MIN_VERSION.major}.${TMUX_MIN_VERSION.minor} or later is needed.`,
    );
    return 1;
  }
  const sockets = [...new Set([...(current?.sockets ?? []), ...(opts.socket ?? [])])];
  for (const s of sockets) {
    if (!s.startsWith("/")) {
      deps.log.error(`Socket paths must be absolute: ${s}`);
      return 1;
    }
  }
  write({ enabled: true, tmuxPath, sockets });
  deps.log.info(`Connect live enabled (${externalControlConfigPath()}), using ${tmuxPath}.`);
  deps.log.info(
    "It also needs the externalControl feature flag (THREADBASE_FEATURE_EXTERNAL_CONTROL=1, or " +
      "feature_flags.externalControl in server.yaml) and a restart, then a grant per device: " +
      "tb-streamer external-control grant --session <id> --device <id>",
  );
  return 0;
}

/** `30m`, `1h`, `90s`, `2h30m` → ms; null when malformed or over the 24 h cap. */
export function parseTtl(raw: string): number | null {
  const re = /(\d+)(h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const m of raw.matchAll(re)) {
    total += Number(m[1]) * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1_000);
    consumed += m[0].length;
  }
  if (consumed !== raw.length || total <= 0 || total > MAX_GRANT_TTL_MS) return null;
  return total;
}

export interface GrantDeps {
  log: ExternalControlCliLog;
  ask?: (q: string) => Promise<string>;
  /** Local discovery + binding, the same resolver the server uses. */
  resolve: (sessionId: string) => Promise<ResolveResult | null>;
  device: (deviceId: string) => { name: string | null; usable: boolean; reason?: string } | null;
  createGrant: (input: {
    deviceId: string;
    sessionId: string;
    bindingFingerprint: string;
    ttlMs: number;
  }) => ExternalControlGrant;
}

function describeBinding(b: ExternalBinding): string {
  return `${b.provider} pid ${b.agentPid} in tmux pane ${b.pane.paneId} (/dev/${b.pane.paneTty})`;
}

export async function runExternalControlGrant(
  opts: { session: string; device: string; ttl: string; yes?: boolean },
  deps: GrantDeps,
): Promise<number> {
  const ttlMs = parseTtl(opts.ttl);
  if (ttlMs == null) {
    deps.log.error("--ttl must look like 30m, 1h or 2h30m, at most 24h.");
    return 1;
  }
  const device = deps.device(opts.device);
  if (!device) {
    deps.log.error(`No such device: ${opts.device}`);
    return 1;
  }
  if (!device.usable) {
    deps.log.error(`Device ${opts.device} cannot be granted: ${device.reason ?? "not usable"}.`);
    return 1;
  }
  const result = await deps.resolve(opts.session);
  if (!result) {
    deps.log.error(`No external agent is running conversation ${opts.session}.`);
    return 1;
  }
  if (!result.ok) {
    deps.log.error(`Conversation ${opts.session} cannot be connected live: ${result.reason}.`);
    return 1;
  }
  const b = result.binding;
  deps.log.info(`Session ${opts.session}: ${describeBinding(b)}`);
  deps.log.info(
    `Device: ${device.name ?? "(unnamed)"} (${opts.device}) may view this pane for ${opts.ttl}.`,
  );
  deps.log.info(
    "The grant ends if the agent exits, switches conversation, or the tmux server restarts.",
  );
  if (!opts.yes) {
    const answer = (await (deps.ask ?? defaultAsk)("Grant? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      deps.log.info("Not granted.");
      return 1;
    }
  }
  const grant = deps.createGrant({
    deviceId: opts.device,
    sessionId: opts.session,
    bindingFingerprint: b.fingerprint,
    ttlMs,
  });
  deps.log.info(
    `Granted ${grant.grantId}, expires ${new Date(grant.expiresAt).toISOString()}. ` +
      `Revoke with: tb-streamer external-control revoke ${grant.grantId}`,
  );
  return 0;
}
