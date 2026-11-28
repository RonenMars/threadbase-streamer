import { createHash } from "crypto";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER } from "../../providers";
import type { TmuxExec } from "../../tmux/client";
import { listPanes, type PaneRecord } from "../../tmux/pane-inventory";
import { type ProcRow, verifyForeground } from "../../tmux/process-table";
import {
  checkSocket,
  defaultSocketPath,
  identifyServer,
  type TmuxServer,
} from "../../tmux/server-registry";
import type { DiscoveredProcess } from "../../types";

/**
 * Joins a process discovery already published to the one tmux pane whose
 * keyboard it is reading. Observational only: it never starts a server, never
 * resumes anything, and treats any doubt as "unavailable".
 */

export interface PaneIdentity {
  serverRef: string;
  generation: string;
  paneId: `%${number}`;
  panePid: number;
  paneTty: string;
}

export interface ExternalBinding {
  bindingId: string;
  /** Hash of every identity input; what a grant is pinned to. */
  fingerprint: string;
  sessionId: string;
  provider: string;
  agentPid: number;
  agentStartToken: string;
  pane: PaneIdentity;
  /** Local only: the socket to address. Never serialised to a client. */
  socketPath: string;
  paneInMode: boolean;
}

export type UnavailableReason =
  | "PROVIDER_UNSUPPORTED"
  | "IDENTITY_UNVERIFIED"
  | "CONVERSATION_CHANGED"
  | "TMUX_UNAVAILABLE"
  | "NOT_IN_TMUX"
  | "NOT_FOREGROUND"
  | "AMBIGUOUS";

export type ResolveResult =
  | { ok: true; binding: ExternalBinding }
  | { ok: false; reason: UnavailableReason };

export interface ResolverDeps {
  exec: TmuxExec;
  sockets: string[];
  bootId: () => Promise<string>;
  processTable: () => Promise<Map<number, ProcRow>>;
  startToken: (pid: number) => Promise<string | null>;
  /** The conversation the process says it is running now (registry / open rollout). */
  currentConversation: (proc: DiscoveredProcess) => Promise<string | null>;
  /** Other discovered agent pids, to catch two agents sharing one foreground group. */
  otherAgentPids: () => number[];
  uid?: number;
  env?: NodeJS.ProcessEnv;
}

/** Providers whose current conversation can be read exactly from a running pid. */
export const LIVE_CONTROL_PROVIDERS = new Set<string>([CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER]);

export function bindingFingerprint(input: {
  provider: string;
  sessionId: string;
  agentPid: number;
  agentStartToken: string;
  serverRef: string;
  generation: string;
  paneId: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.provider,
        input.sessionId,
        input.agentPid,
        input.agentStartToken,
        input.serverRef,
        input.generation,
        input.paneId,
      ].join("\u0000"),
    )
    .digest("hex");
}

/** The configured sockets plus the default one, deduplicated by path. */
export function candidateSockets(
  configured: string[],
  env: NodeJS.ProcessEnv = process.env,
  uid?: number,
): string[] {
  return [...new Set([defaultSocketPath(env, uid), ...configured])];
}

async function serversFor(
  deps: ResolverDeps,
): Promise<{ server: TmuxServer; panes: PaneRecord[] }[]> {
  const bootId = await deps.bootId();
  const settled = await Promise.allSettled(
    candidateSockets(deps.sockets, deps.env, deps.uid).map(async (path) => {
      const check = checkSocket(path, deps.uid);
      if (!check.ok) return null;
      const server = await identifyServer(deps.exec, path, check, bootId);
      if (!server) return null;
      return { server, panes: await listPanes(deps.exec, server.socketPath) };
    }),
  );
  const seen = new Set<string>();
  const out: { server: TmuxServer; panes: PaneRecord[] }[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value) continue;
    // Two registered paths can resolve to one server.
    if (seen.has(s.value.server.serverRef)) continue;
    seen.add(s.value.server.serverRef);
    out.push(s.value);
  }
  return out;
}

export async function resolveBinding(
  proc: DiscoveredProcess,
  sessionId: string,
  deps: ResolverDeps,
): Promise<ResolveResult> {
  if (!LIVE_CONTROL_PROVIDERS.has(proc.provider) || proc.teammate) {
    return { ok: false, reason: "PROVIDER_UNSUPPORTED" };
  }
  const [startToken, current] = await Promise.all([
    deps.startToken(proc.pid),
    deps.currentConversation(proc).catch(() => null),
  ]);
  if (!startToken || current == null) return { ok: false, reason: "IDENTITY_UNVERIFIED" };
  if (current !== sessionId) return { ok: false, reason: "CONVERSATION_CHANGED" };

  const servers = await serversFor(deps);
  if (servers.length === 0) return { ok: false, reason: "TMUX_UNAVAILABLE" };
  const table = await deps.processTable();
  const others = deps.otherAgentPids().filter((p) => p !== proc.pid);

  const matches: { server: TmuxServer; pane: PaneRecord }[] = [];
  let sawTty = false;
  for (const { server, panes } of servers) {
    for (const pane of panes) {
      if (pane.dead) continue;
      const v = verifyForeground(table, proc.pid, pane);
      if (v.ok) {
        // Another agent in the same foreground group would receive the same keys.
        if (others.some((o) => verifyForeground(table, o, pane).ok)) {
          return { ok: false, reason: "AMBIGUOUS" };
        }
        matches.push({ server, pane });
      } else if (v.reason === "background") {
        sawTty = true;
      }
    }
  }
  if (matches.length > 1) return { ok: false, reason: "AMBIGUOUS" };
  if (matches.length === 0) return { ok: false, reason: sawTty ? "NOT_FOREGROUND" : "NOT_IN_TMUX" };

  const { server, pane } = matches[0];
  const fingerprint = bindingFingerprint({
    provider: proc.provider,
    sessionId,
    agentPid: proc.pid,
    agentStartToken: startToken,
    serverRef: server.serverRef,
    generation: server.generation,
    paneId: pane.paneId,
  });
  return {
    ok: true,
    binding: {
      bindingId: `ext_${fingerprint.slice(0, 16)}`,
      fingerprint,
      sessionId,
      provider: proc.provider,
      agentPid: proc.pid,
      agentStartToken: startToken,
      pane: {
        serverRef: server.serverRef,
        generation: server.generation,
        paneId: pane.paneId,
        panePid: pane.panePid,
        paneTty: pane.paneTty,
      },
      socketPath: server.socketPath,
      paneInMode: pane.inMode,
    },
  };
}
