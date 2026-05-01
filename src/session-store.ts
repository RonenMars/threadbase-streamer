import type { DiscoveredProcess, ManagedSession, SessionResponse } from "./types";

export class SessionStore {
  private managed = new Map<string, ManagedSession>();
  private discovered = new Map<number, DiscoveredProcess>();

  addManaged(session: ManagedSession): void {
    this.managed.set(session.id, session);
  }

  updateManaged(sessionId: string, updates: Partial<ManagedSession>): ManagedSession | null {
    const session = this.managed.get(sessionId);
    if (!session) return null;
    Object.assign(session, updates);
    return session;
  }

  removeManaged(sessionId: string): boolean {
    return this.managed.delete(sessionId);
  }

  getManaged(sessionId: string): ManagedSession | null {
    return this.managed.get(sessionId) ?? null;
  }

  setDiscovered(processes: DiscoveredProcess[]): void {
    this.discovered.clear();
    for (const proc of processes) {
      this.discovered.set(proc.pid, proc);
    }
  }

  listManaged(): ManagedSession[] {
    return Array.from(this.managed.values());
  }

  // Build the session list: live PTY sessions (managed) merged with externally
  // discovered Claude processes. Managed sessions keyed by JSONL UUID take
  // priority — discovered processes with the same UUID are skipped.
  list(ptyAttachedIds: Set<string>): SessionResponse[] {
    const results: SessionResponse[] = [];
    const seenIds = new Set<string>();

    for (const s of this.managed.values()) {
      results.push(managedToResponse(s, ptyAttachedIds.has(s.id)));
      seenIds.add(s.id);
    }

    for (const d of this.discovered.values()) {
      // Skip if already represented by a managed session
      if (d.conversationId && seenIds.has(d.conversationId)) continue;
      const id = d.conversationId ?? `disc_${d.pid}`;
      if (seenIds.has(id)) continue;
      results.push(discoveredToResponse(d));
      seenIds.add(id);
    }

    return results;
  }

  get(sessionId: string, ptyAttachedIds: Set<string>): SessionResponse | null {
    const managed = this.managed.get(sessionId);
    if (managed) return managedToResponse(managed, ptyAttachedIds.has(sessionId));

    // Fall back to discovered by UUID or disc_<pid> format
    for (const d of this.discovered.values()) {
      if (d.conversationId === sessionId || `disc_${d.pid}` === sessionId) {
        return discoveredToResponse(d);
      }
    }

    return null;
  }
}

function managedToResponse(s: ManagedSession, ptyAttached: boolean): SessionResponse {
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
    ptyAttached,
    ...(s.sessionName != null && { sessionName: s.sessionName }),
    ...(s.model != null && { model: s.model }),
    ...(s.account != null && { account: s.account }),
    ...(s.messageCount != null && { messageCount: s.messageCount }),
    ...(s.preview != null && { preview: s.preview }),
    ...(s.firstMessageText != null && { firstMessageText: s.firstMessageText }),
    ...(s.firstMessageAt != null && { firstMessageAt: s.firstMessageAt.toISOString() }),
    ...(s.lastMessageText != null && { lastMessageText: s.lastMessageText }),
    ...(s.lastMessageAt != null && { lastMessageAt: s.lastMessageAt.toISOString() }),
    ...(s.lastActivityAt != null && { lastActivityAt: s.lastActivityAt.toISOString() }),
    ...(s.filePath != null && { filePath: s.filePath }),
  };
}

function discoveredToResponse(d: DiscoveredProcess): SessionResponse {
  const id = d.conversationId ?? `disc_${d.pid}`;
  return {
    id,
    status: "idle",
    projectPath: d.projectPath,
    projectName: d.projectName,
    branch: d.branch,
    lastOutput: "",
    elapsedMs: Date.now() - d.startedAt.getTime(),
    promptCount: 0,
    startedAt: d.startedAt.toISOString(),
    completedAt: null,
    ptyAttached: false,
    pid: d.pid,
  };
}
