import type { ManagedSession } from "../types";

export interface SessionPersistence {
  save(session: ManagedSession): Promise<void>;
  update(sessionId: string, updates: Partial<ManagedSession>): Promise<void>;
  remove(sessionId: string): Promise<void>;
  loadAll(): Promise<ManagedSession[]>;
}
