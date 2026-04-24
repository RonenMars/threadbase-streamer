import type { SessionPersistence } from "./db/session-persistence";
import type { DiscoveredProcess, ManagedSession, SessionResponse } from "./types";

export class SessionStore {
  private managed = new Map<string, ManagedSession>();
  private discovered = new Map<number, DiscoveredProcess>();
  private persistence: SessionPersistence | null;

  constructor(persistence?: SessionPersistence) {
    this.persistence = persistence ?? null;
  }

  addManaged(session: ManagedSession): void {
    this.managed.set(session.id, session);
    this.persistence?.save(session);
  }

  updateManaged(sessionId: string, updates: Partial<ManagedSession>): ManagedSession | null {
    const session = this.managed.get(sessionId);
    if (!session) return null;
    Object.assign(session, updates);
    this.persistence?.update(sessionId, updates);
    return session;
  }

  removeManaged(sessionId: string): boolean {
    const existed = this.managed.delete(sessionId);
    if (existed) {
      this.persistence?.remove(sessionId);
    }
    return existed;
  }

  getManaged(sessionId: string): ManagedSession | null {
    return this.managed.get(sessionId) ?? null;
  }

  async rehydrate(): Promise<void> {
    if (!this.persistence) return;
    const sessions = await this.persistence.loadAll();
    for (const session of sessions) {
      this.managed.set(session.id, session);
    }
  }

  setDiscovered(processes: DiscoveredProcess[]): void {
    this.discovered.clear();
    for (const proc of processes) {
      this.discovered.set(proc.pid, proc);
    }
  }

  list(): SessionResponse[] {
    const results: SessionResponse[] = [];

    // Collect managed conversation IDs so we can skip discovered duplicates
    const managedConvIds = new Set<string>();
    for (const s of this.managed.values()) {
      results.push(managedToResponse(s));
      if (s.conversationId) managedConvIds.add(s.conversationId);
    }

    for (const d of this.discovered.values()) {
      // Skip discovered processes that are already tracked as managed sessions
      if (d.conversationId && managedConvIds.has(d.conversationId)) continue;
      results.push(discoveredToResponse(d));
    }

    return results;
  }

  get(sessionId: string): SessionResponse | null {
    const managed = this.managed.get(sessionId);
    if (managed) return managedToResponse(managed);

    // Check discovered by disc_<pid> format
    if (sessionId.startsWith("disc_")) {
      const pid = Number.parseInt(sessionId.slice(5), 10);
      const disc = this.discovered.get(pid);
      if (disc) return discoveredToResponse(disc);
    }

    return null;
  }
}

function managedToResponse(s: ManagedSession): SessionResponse {
  return {
    id: s.id,
    status: s.status,
    projectPath: s.projectPath,
    projectName: s.projectName,
    branch: s.branch,
    lastOutput: s.lastOutput,
    elapsedMs: (s.completedAt ?? new Date()).getTime() - s.startedAt.getTime(),
    promptCount: s.promptCount,
    startedAt: s.startedAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    conversationId: s.conversationId,
    source: "managed",
  };
}

function discoveredToResponse(d: DiscoveredProcess): SessionResponse {
  return {
    id: `disc_${d.pid}`,
    status: "running",
    projectPath: d.projectPath,
    projectName: d.projectName,
    branch: d.branch,
    lastOutput: "",
    elapsedMs: Date.now() - d.startedAt.getTime(),
    promptCount: 0,
    startedAt: d.startedAt.toISOString(),
    completedAt: null,
    conversationId: d.conversationId ?? "",
    source: "discovered",
    pid: d.pid,
  };
}
