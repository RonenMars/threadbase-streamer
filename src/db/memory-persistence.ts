import type { ManagedSession } from "../types";
import type { SessionPersistence } from "./session-persistence";

export class MemorySessionPersistence implements SessionPersistence {
  async save(_session: ManagedSession): Promise<void> {}
  async update(_sessionId: string, _updates: Partial<ManagedSession>): Promise<void> {}
  async remove(_sessionId: string): Promise<void> {}
  async loadAll(): Promise<ManagedSession[]> {
    return [];
  }
}
