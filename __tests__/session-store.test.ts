import { SessionStore } from "../src/session-store";
import type { DiscoveredProcess, ManagedSession } from "../src/types";

function makeManagedSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "ses_abc123",
    conversationId: "conv_xyz",
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
    conversationId: "conv_disc",
    startedAt: new Date("2026-04-18T09:00:00Z"),
    ...overrides,
  };
}

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  describe("managed sessions", () => {
    it("adds and retrieves a managed session", () => {
      const session = makeManagedSession();
      store.addManaged(session);

      const resp = store.get("ses_abc123");
      expect(resp).not.toBeNull();
      expect(resp?.id).toBe("ses_abc123");
      expect(resp?.source).toBe("managed");
      expect(resp?.conversationId).toBe("conv_xyz");
    });

    it("updates a managed session", () => {
      store.addManaged(makeManagedSession());
      const updated = store.updateManaged("ses_abc123", {
        status: "completed",
        completedAt: new Date("2026-04-18T10:05:00Z"),
      });

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toEqual(new Date("2026-04-18T10:05:00Z"));
    });

    it("returns null when updating nonexistent session", () => {
      expect(store.updateManaged("nonexistent", { status: "failed" })).toBeNull();
    });

    it("removes a managed session", () => {
      store.addManaged(makeManagedSession());
      expect(store.removeManaged("ses_abc123")).toBe(true);
      expect(store.get("ses_abc123")).toBeNull();
    });

    it("returns false when removing nonexistent session", () => {
      expect(store.removeManaged("nonexistent")).toBe(false);
    });
  });

  describe("discovered processes", () => {
    it("sets and lists discovered processes", () => {
      store.setDiscovered([makeDiscoveredProcess()]);

      const resp = store.get("disc_12345");
      expect(resp).not.toBeNull();
      expect(resp?.source).toBe("discovered");
      expect(resp?.pid).toBe(12345);
      expect(resp?.status).toBe("running");
    });

    it("replaces previous discovered processes on setDiscovered", () => {
      store.setDiscovered([makeDiscoveredProcess({ pid: 111 })]);
      store.setDiscovered([makeDiscoveredProcess({ pid: 222 })]);

      expect(store.get("disc_111")).toBeNull();
      expect(store.get("disc_222")).not.toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty array when no sessions exist", () => {
      expect(store.list()).toEqual([]);
    });

    it("merges managed and discovered sessions", () => {
      store.addManaged(makeManagedSession());
      store.setDiscovered([makeDiscoveredProcess()]);

      const all = store.list();
      expect(all).toHaveLength(2);

      const sources = all.map((s) => s.source).sort();
      expect(sources).toEqual(["discovered", "managed"]);
    });
  });

  describe("response shape", () => {
    it("includes elapsedMs for managed session", () => {
      const session = makeManagedSession({ startedAt: new Date(Date.now() - 5000) });
      store.addManaged(session);

      const resp = store.get(session.id);
      expect(resp?.elapsedMs).toBeGreaterThanOrEqual(4000);
      expect(resp?.elapsedMs).toBeLessThan(10000);
    });

    it("serializes dates as ISO strings", () => {
      store.addManaged(makeManagedSession());
      const resp = store.get("ses_abc123");
      expect(resp).not.toBeNull();

      expect(resp?.startedAt).toBe("2026-04-18T10:00:00.000Z");
      expect(resp?.completedAt).toBeNull();
    });
  });
});
