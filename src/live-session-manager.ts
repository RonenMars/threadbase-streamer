import { basename } from "path";
import { CodexPtyRunner } from "./codex-pty-runner";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER, type ProviderName } from "./providers";
import type { HostHeartbeatState, HostTransport } from "./pty-host/protocol";
import { RemoteSessionRunner } from "./pty-host/remote-session-runner";
import { PTYManager } from "./pty-manager";
import type {
  ManagedSession,
  PTYManagerOptions,
  SessionRunner,
  StartForkSessionOptions,
  StartFreshSessionOptions,
  StartSessionOptions,
  UserMessage,
} from "./types";

export class LiveSessionManager {
  private runners: Map<ProviderName, SessionRunner>;
  private remoteRunner: RemoteSessionRunner | null = null;
  private options: PTYManagerOptions;

  constructor(options: PTYManagerOptions = {}) {
    this.options = options;
    this.runners = new Map<ProviderName, SessionRunner>([
      [CLAUDE_CODE_PROVIDER, new PTYManager(options)],
      [CODEX_CLI_PROVIDER, new CodexPtyRunner(options)],
    ]);
  }

  async useRemoteRunner(transport: HostTransport): Promise<ManagedSession[]> {
    const remote = await RemoteSessionRunner.connect(transport, this.options);
    await Promise.all(
      remote.listSessions().map((session) => remote.hydrateInputHistory(session.id)),
    );
    for (const runner of this.runners.values()) runner.dispose();
    this.remoteRunner = remote;
    return remote.listSessions();
  }

  isRemote(): boolean {
    return this.remoteRunner !== null;
  }

  startRemoteHeartbeat(getState: () => HostHeartbeatState): void {
    this.remoteRunner?.startHeartbeat(getState);
  }

  async start(
    sessionId: string,
    options: StartSessionOptions & { provider?: ProviderName },
  ): Promise<ManagedSession> {
    const provider = options.provider ?? CLAUDE_CODE_PROVIDER;
    const runner = this.assertSupportedProvider(provider, options.projectPath);
    return runner.start(sessionId, options);
  }

  async startFresh(
    options: StartFreshSessionOptions & { provider?: ProviderName },
  ): Promise<ManagedSession> {
    const provider = options.provider ?? CLAUDE_CODE_PROVIDER;
    const runner = this.assertSupportedProvider(provider, options.projectPath);
    return runner.startFresh(options);
  }

  /**
   * Fork an existing conversation into a new session. Codex-only: `codex fork`
   * has no Claude Code equivalent, and there is no safe generic fallback — a
   * silent downgrade to resume would attach to the very writer the caller is
   * trying to leave alone.
   */
  async startFork(
    options: StartForkSessionOptions & { provider?: ProviderName },
  ): Promise<ManagedSession> {
    const provider = options.provider ?? CODEX_CLI_PROVIDER;
    const runner = this.remoteRunner ?? this.runners.get(provider);
    if (!(runner instanceof CodexPtyRunner)) {
      const err = new Error(
        this.remoteRunner
          ? "Forking is not supported while sessions are hosted by the pty-host"
          : `Forking is not supported for ${provider} sessions`,
      );
      (err as Error & { statusCode?: number }).statusCode = 501;
      throw err;
    }
    return runner.startFork(options);
  }

  sendInput(sessionId: string, input: string): number {
    return this.runnerFor(sessionId).sendInput(sessionId, input);
  }

  sendKeys(sessionId: string, keys: string): void {
    this.runnerFor(sessionId).sendKeys(sessionId, keys);
  }

  cancel(sessionId: string): void {
    this.runnerFor(sessionId).cancel(sessionId);
  }

  killPid(pid: number): void {
    for (const runner of this.activeRunners()) {
      runner.killPid(pid);
    }
  }

  // putOnHold tolerates an unknown sessionId (PTYManager.putOnHold is a no-op
  // when the session isn't in its map), so — unlike the other session-keyed
  // methods — route to the owning runner when found, otherwise broadcast to
  // every runner rather than throwing; this matches the pre-extraction
  // behavior of delegating straight through with no existence check.
  putOnHold(sessionId: string): void {
    for (const runner of this.activeRunners()) {
      if (runner.hasSession(sessionId) || runner.getSession(sessionId)) {
        runner.putOnHold(sessionId);
        return;
      }
    }
    for (const runner of this.activeRunners()) {
      runner.putOnHold(sessionId);
    }
  }

  getOutput(sessionId: string): string {
    return this.runnerFor(sessionId).getOutput(sessionId);
  }

  getOutputLines(sessionId: string, maxLines: number): Promise<string[]> {
    return this.runnerFor(sessionId).getOutputLines(sessionId, maxLines);
  }

  getInputHistory(sessionId: string): UserMessage[] {
    return this.runnerFor(sessionId).getInputHistory(sessionId);
  }

  getSession(sessionId: string): ManagedSession | null {
    for (const runner of this.activeRunners()) {
      const session = runner.getSession(sessionId);
      if (session) return session;
    }
    return null;
  }

  // Scans rather than using runnerFor(): the registry records a pid on a
  // best-effort basis, so an unknown session must return null rather than
  // throw the way the input-routing methods do.
  getPid(sessionId: string): number | null {
    for (const runner of this.activeRunners()) {
      const pid = runner.getPid(sessionId);
      if (pid != null) return pid;
    }
    return null;
  }

  hasSession(sessionId: string): boolean {
    for (const runner of this.activeRunners()) {
      if (runner.hasSession(sessionId)) return true;
    }
    return false;
  }

  listSessions(): ManagedSession[] {
    return this.activeRunners().flatMap((runner) => runner.listSessions());
  }

  dispose(): void {
    for (const runner of this.activeRunners()) {
      runner.dispose();
    }
  }

  // Look up which runner owns a session. Only one runner exists today, so
  // this is a linear scan across hasSession()/getSession() rather than a
  // separate session→provider index — see task-1-brief.md.
  private runnerFor(sessionId: string): SessionRunner {
    for (const runner of this.activeRunners()) {
      if (runner.hasSession(sessionId) || runner.getSession(sessionId)) return runner;
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  private assertSupportedProvider(provider: ProviderName, projectPath: string): SessionRunner {
    if (this.remoteRunner) return this.remoteRunner;
    const runner = this.runners.get(provider);
    if (runner) return runner;
    const err = new Error(
      `Live ${provider} sessions are not implemented yet for ${basename(projectPath)}`,
    );
    (err as Error & { statusCode?: number }).statusCode = 501;
    throw err;
  }

  private activeRunners(): SessionRunner[] {
    return this.remoteRunner ? [this.remoteRunner] : [...this.runners.values()];
  }
}
