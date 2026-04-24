import { vi } from "vitest";
import type { SessionPersistence } from "../src/db/session-persistence";
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

function makePersistenceMock(): SessionPersistence {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn().mockResolvedValue([]),
  };
}

describe("SessionStore with persistence", () => {
  it("calls persistence.save on addManaged", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);
    const session = makeManagedSession();

    store.addManaged(session);

    expect(persistence.save).toHaveBeenCalledWith(session);
  });

  it("calls persistence.update on updateManaged", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);
    store.addManaged(makeManagedSession());

    const updates = { status: "completed" as const };
    store.updateManaged("ses_abc123", updates);

    expect(persistence.update).toHaveBeenCalledWith("ses_abc123", updates);
  });

  it("does not call persistence.update for nonexistent session", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);

    store.updateManaged("nonexistent", { status: "failed" });

    expect(persistence.update).not.toHaveBeenCalled();
  });

  it("calls persistence.remove on removeManaged", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);
    store.addManaged(makeManagedSession());

    store.removeManaged("ses_abc123");

    expect(persistence.remove).toHaveBeenCalledWith("ses_abc123");
  });

  it("does not call persistence.remove for nonexistent session", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);

    store.removeManaged("nonexistent");

    expect(persistence.remove).not.toHaveBeenCalled();
  });

  it("rehydrates managed sessions from persistence", async () => {
    const session = makeManagedSession();
    const persistence = makePersistenceMock();
    (persistence.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue([session]);

    const store = new SessionStore(persistence);
    await store.rehydrate();

    const resp = store.get("ses_abc123");
    expect(resp).not.toBeNull();
    expect(resp?.source).toBe("managed");
    expect(resp?.conversationId).toBe("conv_xyz");
  });

  it("rehydrated sessions dedupe discovered processes", async () => {
    const managed = makeManagedSession({ conversationId: "shared_conv" });
    const persistence = makePersistenceMock();
    (persistence.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue([managed]);

    const store = new SessionStore(persistence);
    await store.rehydrate();

    store.setDiscovered([makeDiscoveredProcess({ conversationId: "shared_conv" })]);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].source).toBe("managed");
  });

  it("rehydrate is a no-op without persistence", async () => {
    const store = new SessionStore();
    await store.rehydrate(); // should not throw
    expect(store.list()).toEqual([]);
  });

  it("does not dedupe discovered when conversationId is null", async () => {
    const managed = makeManagedSession({ conversationId: "conv_a" });
    const persistence = makePersistenceMock();
    (persistence.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue([managed]);

    const store = new SessionStore(persistence);
    await store.rehydrate();

    // Discovered with null conversationId should always appear
    store.setDiscovered([makeDiscoveredProcess({ conversationId: null })]);

    const all = store.list();
    expect(all).toHaveLength(2);
  });

  it("tolerates persistence.save rejection without affecting in-memory state", async () => {
    const persistence = makePersistenceMock();
    (persistence.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));

    const store = new SessionStore(persistence);
    const session = makeManagedSession();

    // addManaged fires persistence.save but doesn't await it — session is still in memory
    store.addManaged(session);
    expect(store.get("ses_abc123")).not.toBeNull();
  });

  it("tolerates persistence.update rejection without affecting in-memory state", async () => {
    const persistence = makePersistenceMock();
    (persistence.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));

    const store = new SessionStore(persistence);
    store.addManaged(makeManagedSession());

    const updated = store.updateManaged("ses_abc123", { status: "completed" });
    expect(updated?.status).toBe("completed");
  });

  it("tolerates persistence.remove rejection without affecting in-memory state", async () => {
    const persistence = makePersistenceMock();
    (persistence.remove as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));

    const store = new SessionStore(persistence);
    store.addManaged(makeManagedSession());

    const removed = store.removeManaged("ses_abc123");
    expect(removed).toBe(true);
    expect(store.get("ses_abc123")).toBeNull();
  });
});
