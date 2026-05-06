import type { SessionStore } from "../../session-store";

/**
 * Sessions live in-memory in SessionStore (Postgres-backed persistence
 * was dropped per the SQLite-only direction). This repository wraps the
 * store with a stable, project-id-aware API for the new services.
 */
export class SessionsRepository {
  constructor(private store: SessionStore) {}

  updateSessionProjectId(args: { sessionId: string; projectId: string }): void {
    this.store.updateManaged(args.sessionId, { projectId: args.projectId });
  }

  listManagedSessions() {
    return this.store.listManaged();
  }
}
