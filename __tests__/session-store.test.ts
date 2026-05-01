import { SessionStore } from "../src/session-store";
import type { DiscoveredProcess, ManagedSession } from "../src/types";

const UUID_A = "039fd3ce-ad78-4980-b441-1cfa05edaec7";
const UUID_B = "05bb7013-97db-4c47-82cb-149d17b53d1a";

function makeManagedSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: UUID_A,
    projectPath: "/tmp/project",
    projectName: "project",
    branch: "main",
    status: "running",
    startedAt: new Date("2026-04-18T10:00:00Z"),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    ...overrides,
  };
}

function makeDiscoveredProcess(overrides: Partial<DiscoveredProcess> = {}): DiscoveredProcess {
  return {
    pid: 12345,
    projectPath: "/tmp/discovered",
    projectName: "discovered",
    branch: "feature",
    conversationId: UUID_B,
    startedAt: new Date("2026-04-18T09:00:00Z"),
    ...overrides,
  };
}

describe("SessionStore", () => {
  let store: SessionStore;
  const noPty = new Set<string>();

  beforeEach(() => {
    store = new SessionStore();
  });

  describe("managed sessions", () => {
    it("adds and retrieves a managed session", () => {
      store.addManaged(makeManagedSession());

      const resp = store.get(UUID_A, noPty);
      expect(resp).not.toBeNull();
      expect(resp?.id).toBe(UUID_A);
      expect(resp?.ptyAttached).toBe(false);
    });

    it("ptyAttached reflects the live PTY set", () => {
      store.addManaged(makeManagedSession());

      const withPty = new Set([UUID_A]);
      expect(store.get(UUID_A, withPty)?.ptyAttached).toBe(true);
      expect(store.get(UUID_A, noPty)?.ptyAttached).toBe(false);
    });

    it("updates a managed session", () => {
      store.addManaged(makeManagedSession());
      const updated = store.updateManaged(UUID_A, {
        status: "idle",
        completedAt: new Date("2026-04-18T10:05:00Z"),
      });

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe("idle");
      expect(updated?.completedAt).toEqual(new Date("2026-04-18T10:05:00Z"));
    });

    it("returns null when updating nonexistent session", () => {
      expect(store.updateManaged("nonexistent", { status: "idle" })).toBeNull();
    });

    it("removes a managed session", () => {
      store.addManaged(makeManagedSession());
      expect(store.removeManaged(UUID_A)).toBe(true);
      expect(store.get(UUID_A, noPty)).toBeNull();
    });

    it("returns false when removing nonexistent session", () => {
      expect(store.removeManaged("nonexistent")).toBe(false);
    });
  });

  describe("discovered processes", () => {
    it("sets and lists discovered processes using conversationId as id", () => {
      store.setDiscovered([makeDiscoveredProcess()]);

      const resp = store.get(UUID_B, noPty);
      expect(resp).not.toBeNull();
      expect(resp?.ptyAttached).toBe(false);
      expect(resp?.pid).toBe(12345);
      expect(resp?.status).toBe("idle");
    });

    it("skips discovered processes with null conversationId", () => {
      store.setDiscovered([makeDiscoveredProcess({ conversationId: null })]);

      const resp = store.get("disc_12345", noPty);
      expect(resp).toBeNull();
      expect(store.list(noPty)).toHaveLength(0);
    });

    it("replaces previous discovered processes on setDiscovered", () => {
      store.setDiscovered([makeDiscoveredProcess({ pid: 111, conversationId: "aaa" })]);
      store.setDiscovered([makeDiscoveredProcess({ pid: 222, conversationId: "bbb" })]);

      expect(store.get("aaa", noPty)).toBeNull();
      expect(store.get("bbb", noPty)).not.toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty array when no sessions exist", () => {
      expect(store.list(noPty)).toEqual([]);
    });

    it("merges managed and discovered sessions", () => {
      store.addManaged(makeManagedSession());
      store.setDiscovered([makeDiscoveredProcess()]);

      const all = store.list(noPty);
      expect(all).toHaveLength(2);
      const ids = all.map((s) => s.id).sort();
      expect(ids).toContain(UUID_A);
      expect(ids).toContain(UUID_B);
    });

    it("deduplicates when discovered has same UUID as managed", () => {
      store.addManaged(makeManagedSession({ id: UUID_A }));
      // Discovered process is resuming the same conversation
      store.setDiscovered([makeDiscoveredProcess({ conversationId: UUID_A })]);

      const all = store.list(noPty);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(UUID_A);
    });

    it("omits discovered process when conversationId is null", () => {
      store.addManaged(makeManagedSession());
      store.setDiscovered([makeDiscoveredProcess({ conversationId: null })]);

      const all = store.list(noPty);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(UUID_A);
    });
  });

  describe("response shape", () => {
    it("includes elapsedMs for managed session", () => {
      const session = makeManagedSession({ startedAt: new Date(Date.now() - 5000) });
      store.addManaged(session);

      const resp = store.get(session.id, noPty);
      expect(resp?.elapsedMs).toBeGreaterThanOrEqual(4000);
      expect(resp?.elapsedMs).toBeLessThan(10000);
    });

    it("serializes dates as ISO strings", () => {
      store.addManaged(makeManagedSession());
      const resp = store.get(UUID_A, noPty);
      expect(resp).not.toBeNull();
      expect(resp?.startedAt).toBe("2026-04-18T10:00:00.000Z");
      expect(resp?.completedAt).toBeNull();
    });

    it("maps conversation metadata fields to response", () => {
      store.addManaged(
        makeManagedSession({
          sessionName: "test-session",
          model: "claude-opus-4-6",
          account: "default",
          messageCount: 42,
          preview: "Hello world",
          firstMessageText: "Hi there",
          firstMessageAt: new Date("2026-04-18T09:55:00Z"),
          lastMessageText: "Goodbye",
          lastMessageAt: new Date("2026-04-18T10:00:00Z"),
          filePath: "/tmp/conv.jsonl",
        }),
      );

      const resp = store.get(UUID_A, noPty);
      expect(resp?.sessionName).toBe("test-session");
      expect(resp?.model).toBe("claude-opus-4-6");
      expect(resp?.account).toBe("default");
      expect(resp?.messageCount).toBe(42);
      expect(resp?.preview).toBe("Hello world");
      expect(resp?.firstMessageText).toBe("Hi there");
      expect(resp?.firstMessageAt).toBe("2026-04-18T09:55:00.000Z");
      expect(resp?.lastMessageText).toBe("Goodbye");
      expect(resp?.lastMessageAt).toBe("2026-04-18T10:00:00.000Z");
      expect(resp?.filePath).toBe("/tmp/conv.jsonl");
    });

    it("omits undefined metadata fields from response", () => {
      store.addManaged(makeManagedSession());
      const resp = store.get(UUID_A, noPty);
      expect(resp?.sessionName).toBeUndefined();
      expect(resp?.model).toBeUndefined();
    });
  });
});
