import { getLogger } from "../../logger";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER } from "../../providers";
import type { SessionStore } from "../../session-store";
import {
  createTmuxExec,
  parseTmuxVersion,
  readTmuxVersion,
  type TmuxExec,
  tmuxVersionSupported,
} from "../../tmux/client";
import { listPanes } from "../../tmux/pane-inventory";
import { processStartToken, readProcessTable, verifyForeground } from "../../tmux/process-table";
import { capturePane, type PaneScreen } from "../../tmux/screen";
import { bootIdentity } from "../../tmux/server-registry";
import type { DiscoveredProcess } from "../../types";
import type { Principal } from "../security/capabilities";
import { codexRolloutIdForPid, readClaudeSessionRegistry } from "../sessions/processSessionIds";
import type { ExternalControlConfig } from "./config";
import type { ExternalControlGrantsRepository } from "./repository";
import {
  type ExternalBinding,
  type ResolverDeps,
  resolveBinding,
  type UnavailableReason,
} from "./resolver";

const log = getLogger("external-control");

export type StatusReason =
  | UnavailableReason
  | "NOT_CONFIGURED"
  | "TMUX_VERSION_UNSUPPORTED"
  | "NOT_EXTERNAL"
  | "CONTROL_NOT_GRANTED"
  | "DEVICE_CREDENTIAL_REQUIRED"
  | "GRANTS_UNAVAILABLE";

export interface LiveControlStatus {
  available: boolean;
  reason?: StatusReason;
  runtime: "tmux";
  capabilities: { screen: boolean; input: false };
  /** Only for a device holding a grant on this exact binding. */
  bindingId?: string;
  bindingRevision?: number;
  grantExpiresAt?: string;
  /** Copy mode etc.: the screen is readable but would not take input. */
  paneInMode?: boolean;
}

export type ScreenResult =
  | { ok: true; bindingId: string; screen: PaneScreen }
  | { ok: false; status: number; code: string; reason?: StatusReason };

export interface ExternalControlServiceDeps {
  config: () => ExternalControlConfig | null;
  sessionStore: Pick<SessionStore, "externalFor" | "externalProcesses">;
  grants: () => ExternalControlGrantsRepository | null;
  /** Injectable for tests; defaults build the real tmux/ps/registry readers. */
  resolverDeps?: (config: ExternalControlConfig) => ResolverDeps;
  versionCheck?: (tmuxPath: string) => Promise<boolean>;
  now?: () => number;
}

function unavailable(reason: StatusReason): LiveControlStatus {
  return {
    available: false,
    reason,
    runtime: "tmux",
    capabilities: { screen: false, input: false },
  };
}

export function currentConversationFor(proc: DiscoveredProcess): Promise<string | null> {
  if (proc.provider === CLAUDE_CODE_PROVIDER) {
    return readClaudeSessionRegistry(proc.pid, { processStartedAt: proc.startedAt }).then(
      (e) => e?.sessionId ?? null,
    );
  }
  if (proc.provider === CODEX_CLI_PROVIDER) return codexRolloutIdForPid(proc.pid);
  return Promise.resolve(null);
}

/** The real tmux, ps and provider-registry readers; shared by the server and the CLI. */
export function buildResolverDeps(
  config: ExternalControlConfig,
  exec: TmuxExec,
  otherAgentPids: () => number[],
): ResolverDeps {
  return {
    exec,
    sockets: config.sockets,
    bootId: bootIdentity,
    processTable: readProcessTable,
    startToken: processStartToken,
    currentConversation: currentConversationFor,
    otherAgentPids,
  };
}

/**
 * The read-only half of "Connect live" (phase 1): is this external session
 * bound to exactly one tmux pane, and may this device see that pane. It holds
 * no lease, sends no keys and never touches the agent's lifecycle.
 */
export class ExternalControlService {
  private readonly execs = new Map<string, TmuxExec>();
  private readonly versionOk = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: ExternalControlServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private resolverDeps(config: ExternalControlConfig): ResolverDeps {
    if (this.deps.resolverDeps) return this.deps.resolverDeps(config);
    let exec = this.execs.get(config.tmuxPath);
    if (!exec) {
      exec = createTmuxExec(config.tmuxPath);
      this.execs.set(config.tmuxPath, exec);
    }
    return buildResolverDeps(config, exec, () =>
      this.deps.sessionStore.externalProcesses().map((p) => p.pid),
    );
  }

  private versionSupported(tmuxPath: string): Promise<boolean> {
    if (this.deps.versionCheck) return this.deps.versionCheck(tmuxPath);
    let p = this.versionOk.get(tmuxPath);
    if (!p) {
      p = readTmuxVersion(tmuxPath).then(
        (out) => tmuxVersionSupported(parseTmuxVersion(out)),
        () => false,
      );
      this.versionOk.set(tmuxPath, p);
    }
    return p;
  }

  private async bind(
    sessionId: string,
  ): Promise<
    | { ok: true; binding: ExternalBinding; config: ExternalControlConfig }
    | { ok: false; reason: StatusReason; notFound?: boolean }
  > {
    const config = this.deps.config();
    if (!config) return { ok: false, reason: "NOT_CONFIGURED" };
    if (!(await this.versionSupported(config.tmuxPath))) {
      return { ok: false, reason: "TMUX_VERSION_UNSUPPORTED" };
    }
    const proc = this.deps.sessionStore.externalFor(sessionId);
    if (!proc) return { ok: false, reason: "NOT_EXTERNAL" };
    const started = this.now();
    const result = await resolveBinding(proc, sessionId, this.resolverDeps(config)).catch(() => ({
      ok: false as const,
      reason: "TMUX_UNAVAILABLE" as const,
    }));
    log.info("external_control.bind", {
      outcome: result.ok ? "bound" : result.reason,
      provider: proc.provider,
      ...(result.ok && { bindingId: result.binding.bindingId }),
      durationMs: this.now() - started,
    });
    return result.ok ? { ...result, config } : result;
  }

  /** Device principals only: the shared API key names no device a grant could be for. */
  private grantFor(principal: Principal | undefined, binding: ExternalBinding) {
    if (principal?.kind !== "device" || !principal.deviceId) {
      return { ok: false as const, reason: "DEVICE_CREDENTIAL_REQUIRED" as const };
    }
    const repo = this.deps.grants();
    if (!repo) return { ok: false as const, reason: "GRANTS_UNAVAILABLE" as const };
    const grant = repo.findActive(principal.deviceId, binding.fingerprint, "screen", this.now());
    return grant
      ? { ok: true as const, grant }
      : { ok: false as const, reason: "CONTROL_NOT_GRANTED" as const };
  }

  /** Whether the session exists for this API at all (managed or external). */
  async status(sessionId: string, principal: Principal | undefined): Promise<LiveControlStatus> {
    const bound = await this.bind(sessionId);
    if (!bound.ok) return unavailable(bound.reason);
    const grant = this.grantFor(principal, bound.binding);
    // The pane exists and is eligible, but nothing identifying leaves the
    // server until this device holds a grant on this exact binding.
    if (!grant.ok) return { ...unavailable(grant.reason) };
    return {
      available: true,
      runtime: "tmux",
      capabilities: { screen: true, input: false },
      bindingId: bound.binding.bindingId,
      bindingRevision: 0,
      grantExpiresAt: new Date(grant.grant.expiresAt).toISOString(),
      paneInMode: bound.binding.paneInMode,
    };
  }

  async screen(sessionId: string, principal: Principal | undefined): Promise<ScreenResult> {
    const bound = await this.bind(sessionId);
    if (!bound.ok) {
      if (bound.reason === "NOT_CONFIGURED" || bound.reason === "TMUX_VERSION_UNSUPPORTED") {
        return { ok: false, status: 503, code: "TMUX_UNAVAILABLE", reason: bound.reason };
      }
      if (bound.reason === "TMUX_UNAVAILABLE") {
        return { ok: false, status: 503, code: "TMUX_UNAVAILABLE", reason: bound.reason };
      }
      return { ok: false, status: 409, code: "EXTERNAL_BINDING_STALE", reason: bound.reason };
    }
    const grant = this.grantFor(principal, bound.binding);
    if (!grant.ok)
      return { ok: false, status: 403, code: "CONTROL_NOT_GRANTED", reason: grant.reason };

    const { binding, config } = bound;
    const deps = this.resolverDeps(config);
    let screen: PaneScreen;
    try {
      screen = await capturePane(deps.exec, binding.socketPath, binding.pane.paneId);
    } catch {
      return { ok: false, status: 503, code: "TMUX_UNAVAILABLE", reason: "TMUX_UNAVAILABLE" };
    }
    // The agent can exit between bind and capture, leaving its shell on the
    // pane. Recheck after the capture so a shell screen is never served as
    // the agent's.
    if (!(await this.stillBound(binding, deps))) {
      return { ok: false, status: 409, code: "EXTERNAL_BINDING_STALE", reason: "NOT_FOREGROUND" };
    }
    return { ok: true, bindingId: binding.bindingId, screen };
  }

  private async stillBound(binding: ExternalBinding, deps: ResolverDeps): Promise<boolean> {
    try {
      const [panes, table, token] = await Promise.all([
        listPanes(deps.exec, binding.socketPath),
        deps.processTable(),
        deps.startToken(binding.agentPid),
      ]);
      const pane = panes.find((p) => p.paneId === binding.pane.paneId);
      if (!pane || pane.dead || pane.panePid !== binding.pane.panePid) return false;
      if (token !== binding.agentStartToken) return false;
      return verifyForeground(table, binding.agentPid, pane).ok;
    } catch {
      return false;
    }
  }
}
