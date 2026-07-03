import { basename } from "path";
import { CLAUDE_CODE_PROVIDER, type ProviderName } from "./providers";
import { PTYManager } from "./pty-manager";
import type {
  ManagedSession,
  PTYManagerOptions,
  StartFreshSessionOptions,
  StartSessionOptions,
} from "./types";

export class LiveSessionManager {
  private claudeRunner: PTYManager;

  constructor(options: PTYManagerOptions = {}) {
    this.claudeRunner = new PTYManager(options);
  }

  async start(
    sessionId: string,
    options: StartSessionOptions & { provider?: ProviderName },
  ): Promise<ManagedSession> {
    this.assertSupportedProvider(options.provider ?? CLAUDE_CODE_PROVIDER, options.projectPath);
    return this.claudeRunner.start(sessionId, options);
  }

  async startFresh(
    options: StartFreshSessionOptions & { provider?: ProviderName },
  ): Promise<ManagedSession> {
    this.assertSupportedProvider(options.provider ?? CLAUDE_CODE_PROVIDER, options.projectPath);
    return this.claudeRunner.startFresh(options);
  }

  sendInput(sessionId: string, input: string): number {
    return this.claudeRunner.sendInput(sessionId, input);
  }

  sendKeys(sessionId: string, keys: string): void {
    this.claudeRunner.sendKeys(sessionId, keys);
  }

  cancel(sessionId: string): void {
    this.claudeRunner.cancel(sessionId);
  }

  killPid(pid: number): void {
    this.claudeRunner.killPid(pid);
  }

  putOnHold(sessionId: string): void {
    this.claudeRunner.putOnHold(sessionId);
  }

  getOutput(sessionId: string): string {
    return this.claudeRunner.getOutput(sessionId);
  }

  getOutputLines(sessionId: string, maxLines: number): Promise<string[]> {
    return this.claudeRunner.getOutputLines(sessionId, maxLines);
  }

  getSession(sessionId: string): ManagedSession | null {
    return this.claudeRunner.getSession(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.claudeRunner.hasSession(sessionId);
  }

  listSessions(): ManagedSession[] {
    return this.claudeRunner.listSessions();
  }

  dispose(): void {
    this.claudeRunner.dispose();
  }

  private assertSupportedProvider(provider: ProviderName, projectPath: string): void {
    if (provider === CLAUDE_CODE_PROVIDER) return;
    const err = new Error(
      `Live ${provider} sessions are not implemented yet for ${basename(projectPath)}`,
    );
    (err as Error & { statusCode?: number }).statusCode = 501;
    throw err;
  }
}
