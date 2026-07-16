import { basename } from "path";
import { CodexPtyRunner } from "./codex-pty-runner";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER, type ProviderName } from "./providers";
import { PTYManager } from "./pty-manager";
import type {
  ManagedSession,
  PTYManagerOptions,
  SessionRunner,
  StartFreshSessionOptions,
  StartSessionOptions,
  UserMessage,
} from "./types";

export class LiveSessionManager {
  private runners: Map<ProviderName, SessionRunner>;

  constructor(options: PTYManagerOptions = {}) {
    this.runners = new Map<ProviderName, SessionRunner>([
      [CLAUDE_CODE_PROVIDER, new PTYManager(options)],
      [CODEX_CLI_PROVIDER, new CodexPtyRunner(options)],
    ]);
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
    for (const runner of this.runners.values()) {
      runner.killPid(pid);
    }
  }

  // putOnHold tolerates an unknown sessionId (PTYManager.putOnHold is a no-op
  // when the session isn't in its map), so — unlike the other session-keyed
  // methods — route to the owning runner when found, otherwise broadcast to
  // every runner rather than throwing; this matches the pre-extraction
  // behavior of delegating straight through with no existence check.
  putOnHold(sessionId: string): void {
    for (const runner of this.runners.values()) {
      if (runner.hasSession(sessionId) || runner.getSession(sessionId)) {
        runner.putOnHold(sessionId);
        return;
      }
    }
    for (const runner of this.runners.values()) {
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
    for (const runner of this.runners.values()) {
      const session = runner.getSession(sessionId);
      if (session) return session;
    }
    return null;
  }

  hasSession(sessionId: string): boolean {
    for (const runner of this.runners.values()) {
      if (runner.hasSession(sessionId)) return true;
    }
    return false;
  }

  listSessions(): ManagedSession[] {
    return Array.from(this.runners.values()).flatMap((runner) => runner.listSessions());
  }

  dispose(): void {
    for (const runner of this.runners.values()) {
      runner.dispose();
    }
  }

  // Look up which runner owns a session. Only one runner exists today, so
  // this is a linear scan across hasSession()/getSession() rather than a
  // separate session→provider index — see task-1-brief.md.
  private runnerFor(sessionId: string): SessionRunner {
    for (const runner of this.runners.values()) {
      if (runner.hasSession(sessionId) || runner.getSession(sessionId)) return runner;
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  private assertSupportedProvider(provider: ProviderName, projectPath: string): SessionRunner {
    const runner = this.runners.get(provider);
    if (runner) return runner;
    const err = new Error(
      `Live ${provider} sessions are not implemented yet for ${basename(projectPath)}`,
    );
    (err as Error & { statusCode?: number }).statusCode = 501;
    throw err;
  }
}
