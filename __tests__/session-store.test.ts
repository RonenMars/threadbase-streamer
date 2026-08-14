import { decodeCursor, encodeCursor, SessionStore } from "../src/session-store";
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
      expect(resp?.provider).toBe("claude-code");
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

    // A session is added at spawn, before its first user message exists, so the
    // derived name can only ever arrive on a later update. server.ts's
    // onStatusChange mirrors it in from the runner's own copy; this pins the
    // half SessionStore owns — a name that arrives late must reach the wire.
    it("surfaces a sessionName that arrives after the session was added", () => {
      store.addManaged(makeManagedSession({ sessionName: undefined }));
      expect(store.get(UUID_A, noPty)?.sessionName).toBeUndefined();

      store.updateManaged(UUID_A, { status: "running", sessionName: "fix the parser" });

      expect(store.get(UUID_A, noPty)?.sessionName).toBe("fix the parser");
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
      expect(resp?.provider).toBe("claude-code");
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

  // lifecycle is the process-lifetime axis added by C1, orthogonal to `status`.
  // It exists because `idle` was overloaded: finished, killed-to-save-resources,
  // and externally-discovered were indistinguishable.
  describe("lifecycle", () => {
    it("reports attached while this run holds the PTY", () => {
      const session = makeManagedSession();
      store.addManaged(session);

      const resp = store.get(session.id, new Set([session.id]));
      expect(resp?.lifecycle).toBe("attached");
      expect(resp?.ptyAttached).toBe(true);
    });

    it("reports completed once the PTY is gone with no failure recorded", () => {
      store.addManaged(makeManagedSession({ status: "idle", completedAt: new Date() }));

      const resp = store.get(UUID_A, noPty);
      expect(resp?.lifecycle).toBe("completed");
    });

    // The pre-attach window. Every exit path stamps completedAt (both runners'
    // handleExit); without it there is no evidence the session ever ended, so
    // reporting `completed` made "has not started" and "has ended" the same
    // value on the wire — the ambiguity tb-mobile #508 needs resolved.
    it("reports starting when no PTY is held and no exit was observed", () => {
      store.addManaged(makeManagedSession({ status: "running", completedAt: null }));

      const resp = store.get(UUID_A, noPty);
      expect(resp?.lifecycle).toBe("starting");
      expect(resp?.lifecycleSource).toBe("spawn");
    });

    it("leaves starting for attached once the PTY shows up", () => {
      const session = makeManagedSession({ completedAt: null });
      store.addManaged(session);

      expect(store.get(session.id, noPty)?.lifecycle).toBe("starting");
      expect(store.get(session.id, new Set([session.id]))?.lifecycle).toBe("attached");
    });

    it("prefers failed over starting when a failure was recorded without completedAt", () => {
      store.addManaged(
        makeManagedSession({ status: "idle", completedAt: null, failureReason: "binary missing" }),
      );

      expect(store.get(UUID_A, noPty)?.lifecycle).toBe("failed");
    });

    it("reports failed when a failure reason was recorded", () => {
      store.addManaged(makeManagedSession({ status: "idle", failureReason: "binary missing" }));

      const resp = store.get(UUID_A, noPty);
      expect(resp?.lifecycle).toBe("failed");
    });

    // putOnHold (grace timer, explicit hold_session, idle reaper) kills the PTY
    // the same way a real exit does — ptyAttached goes false, completedAt gets
    // stamped — but the conversation is still resumable, not terminal. Both
    // runners' putOnHold set statusSource: "shutdown", and nothing else does,
    // so it is the one signal that tells a hold apart from a genuine exit.
    it("reports resumable when this run put the session on hold rather than exited", () => {
      store.addManaged(makeManagedSession({ status: "idle", statusSource: "shutdown" }));

      const resp = store.get(UUID_A, noPty);
      expect(resp?.lifecycle).toBe("resumable");
    });

    it("still reports completed for a genuine exit (statusSource: process-exit)", () => {
      store.addManaged(
        makeManagedSession({
          status: "idle",
          statusSource: "process-exit",
          completedAt: new Date(),
        }),
      );

      const resp = store.get(UUID_A, noPty);
      expect(resp?.lifecycle).toBe("completed");
    });

    // Multi-agent sessions never appear in a PTY runner's map, so ptyAttached is
    // always false — but while status is live they are actively being worked,
    // not terminal. `currentTurnId` is the multi-agent marker (undefined in PTY).
    it("reports attached for a live multi-agent session with no PTY", () => {
      store.addManaged(makeManagedSession({ status: "running", currentTurnId: null }));

      const resp = store.get(UUID_A, noPty);
      expect(resp?.lifecycle).toBe("attached");
      expect(resp?.lifecycleSource).toBe("spawn");
      expect(resp?.ptyAttached).toBe(false);
      expect(resp?.status).toBe("running");
    });

    it("reports attached for a multi-agent session mid-turn", () => {
      store.addManaged(makeManagedSession({ status: "running", currentTurnId: "turn_1" }));

      expect(store.get(UUID_A, noPty)?.lifecycle).toBe("attached");
    });

    it("reports completed once a multi-agent session is idle", () => {
      store.addManaged(makeManagedSession({ status: "idle", currentTurnId: null }));

      const resp = store.get(UUID_A, noPty);
      expect(resp?.lifecycle).toBe("completed");
      expect(resp?.lifecycleSource).toBe("exit");
    });

    // An external process is alive but we hold no PTY for it — which is exactly
    // `detached`, and more informative than the `idle` status discovery is
    // forced to report because it cannot see the process's prompt state.
    it("reports an externally discovered process as detached", () => {
      store.setDiscovered([
        {
          pid: 999,
          projectPath: "/tmp/x",
          projectName: "x",
          branch: "",
          startedAt: new Date(),
          conversationId: UUID_B,
        } as never,
      ]);

      const resp = store.get(UUID_B, noPty);
      expect(resp?.lifecycle).toBe("detached");
      expect(resp?.status).toBe("idle");
    });

    // ptyAttached keeps its old meaning so clients that ignore lifecycle are
    // unaffected — the additive-change rule while both branches are in flight.
    it("keeps ptyAttached consistent with lifecycle === attached", () => {
      const session = makeManagedSession();
      store.addManaged(session);

      const attached = store.get(session.id, new Set([session.id]));
      const detached = store.get(session.id, noPty);
      expect(attached?.ptyAttached).toBe(attached?.lifecycle === "attached");
      expect(detached?.ptyAttached).toBe(false);
      expect(detached?.lifecycle).not.toBe("attached");
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

  describe("paginate", () => {
    function seed(n: number): string[] {
      // Sessions are ordered such that startedAt and id both monotonically
      // increase with i — i.e. the newest session has the largest id.
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
        ids.push(id);
        store.addManaged(
          makeManagedSession({
            id,
            startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
            projectName: `proj-${i}`,
          }),
        );
      }
      return ids;
    }

    it("returns all items in a single page when total ≤ limit", () => {
      seed(3);
      const page = store.paginate(noPty, { limit: 10, sortBy: "startedAt", order: "desc" });
      expect(page.sessions).toHaveLength(3);
      expect(page.total).toBe(3);
      expect(page.nextCursor).toBeNull();
    });

    it("paginates by startedAt DESC and the union of pages equals the unpaginated sorted list", () => {
      const ids = seed(5);
      const expected = [...ids].reverse(); // newest first

      const page1 = store.paginate(noPty, { limit: 2, sortBy: "startedAt", order: "desc" });
      expect(page1.sessions.map((s) => s.id)).toEqual(expected.slice(0, 2));
      expect(page1.total).toBe(5);
      expect(page1.nextCursor).not.toBeNull();

      if (!page1.nextCursor) throw new Error("expected page1.nextCursor");
      const page2 = store.paginate(noPty, {
        limit: 2,
        sortBy: "startedAt",
        order: "desc",
        cursor: page1.nextCursor,
      });
      expect(page2.sessions.map((s) => s.id)).toEqual(expected.slice(2, 4));

      if (!page2.nextCursor) throw new Error("expected page2.nextCursor");
      const page3 = store.paginate(noPty, {
        limit: 2,
        sortBy: "startedAt",
        order: "desc",
        cursor: page2.nextCursor,
      });
      expect(page3.sessions.map((s) => s.id)).toEqual(expected.slice(4, 5));
      expect(page3.nextCursor).toBeNull();
    });

    it("uses id as a tiebreaker when sort key values collide", () => {
      const sameTime = new Date("2026-01-01T00:00:00Z");
      const idLow = "00000000-0000-0000-0000-000000000001";
      const idHigh = "00000000-0000-0000-0000-000000000002";
      store.addManaged(makeManagedSession({ id: idLow, startedAt: sameTime, projectName: "a" }));
      store.addManaged(makeManagedSession({ id: idHigh, startedAt: sameTime, projectName: "b" }));

      const desc = store.paginate(noPty, { limit: 10, sortBy: "startedAt", order: "desc" });
      // Tiebreaker on id is always ascending, so when sort key ties we fall
      // back to id ASC regardless of `order`.
      expect(desc.sessions.map((s) => s.id)).toEqual([idLow, idHigh]);
    });

    it("filters by status before paginating, and total reflects the filter", () => {
      store.addManaged(makeManagedSession({ id: "a-id", status: "running" }));
      store.addManaged(makeManagedSession({ id: "b-id", status: "idle" }));
      store.addManaged(makeManagedSession({ id: "c-id", status: "running" }));

      const page = store.paginate(noPty, {
        limit: 10,
        sortBy: "startedAt",
        order: "desc",
        status: ["running"],
      });
      expect(page.sessions.map((s) => s.id).sort()).toEqual(["a-id", "c-id"]);
      expect(page.total).toBe(2);
    });

    it("sorts by projectName ASC", () => {
      store.addManaged(makeManagedSession({ id: "id-c", projectName: "c-proj" }));
      store.addManaged(makeManagedSession({ id: "id-a", projectName: "a-proj" }));
      store.addManaged(makeManagedSession({ id: "id-b", projectName: "b-proj" }));

      const page = store.paginate(noPty, { limit: 10, sortBy: "projectName", order: "asc" });
      expect(page.sessions.map((s) => s.projectName)).toEqual(["a-proj", "b-proj", "c-proj"]);
    });

    it("sorts by status rank — live statuses first, most recently active first", () => {
      const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));
      store.addManaged(
        makeManagedSession({ id: "id-idle-new", status: "idle", lastActivityAt: at(50) }),
      );
      store.addManaged(
        makeManagedSession({ id: "id-run-old", status: "running", lastActivityAt: at(10) }),
      );
      store.addManaged(
        makeManagedSession({ id: "id-wait-new", status: "waiting_input", lastActivityAt: at(40) }),
      );
      store.addManaged(
        makeManagedSession({ id: "id-idle-old", status: "idle", lastActivityAt: at(5) }),
      );

      const asc = store.paginate(noPty, { limit: 10, sortBy: "status", order: "asc" });
      expect(asc.sessions.map((s) => s.id)).toEqual([
        "id-wait-new", // live bucket, newest activity
        "id-run-old", // live bucket — `running` and `waiting_input` rank equally
        "id-idle-new",
        "id-idle-old",
      ]);

      // `desc` reverses the whole ordering: idle first, oldest first.
      const desc = store.paginate(noPty, { limit: 10, sortBy: "status", order: "desc" });
      expect(desc.sessions.map((s) => s.id)).toEqual([
        "id-idle-old",
        "id-idle-new",
        "id-run-old",
        "id-wait-new",
      ]);
    });

    it("paginates by status rank without skipping or duplicating a stable list", () => {
      const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));
      for (let i = 0; i < 4; i++) {
        store.addManaged(
          makeManagedSession({
            id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
            status: i % 2 === 0 ? "running" : "idle",
            lastActivityAt: at(i),
          }),
        );
      }
      const all = store.paginate(noPty, { limit: 10, sortBy: "status", order: "asc" });

      const page1 = store.paginate(noPty, { limit: 2, sortBy: "status", order: "asc" });
      if (!page1.nextCursor) throw new Error("expected page1.nextCursor");
      const page2 = store.paginate(noPty, {
        limit: 2,
        sortBy: "status",
        order: "asc",
        cursor: page1.nextCursor,
      });

      expect([...page1.sessions, ...page2.sessions].map((s) => s.id)).toEqual(
        all.sessions.map((s) => s.id),
      );
    });

    it("encodeCursor/decodeCursor round-trip preserves values", () => {
      const cursor = { k: "2026-01-01T00:00:00.000Z", id: UUID_A };
      const encoded = encodeCursor(cursor);
      expect(decodeCursor(encoded)).toEqual(cursor);
    });

    it("decodeCursor throws INVALID_CURSOR on garbage input", () => {
      expect(() => decodeCursor("not-base64-!!!")).toThrow("INVALID_CURSOR");
      expect(() => decodeCursor(Buffer.from("not json", "utf8").toString("base64url"))).toThrow(
        "INVALID_CURSOR",
      );
      expect(() =>
        decodeCursor(Buffer.from(JSON.stringify({ id: 5, k: "x" }), "utf8").toString("base64url")),
      ).toThrow("INVALID_CURSOR");
    });
  });

  describe("managedToResponse — a rehydrated session", () => {
    // `rehydrated` marks a stub the boot rehydrator seeded from the durable
    // registry: a previous run's session, with no process behind it.
    it("reports historical ownership and a resumable lifecycle", () => {
      store.addManaged(makeManagedSession({ status: "idle", rehydrated: true }));

      const [resp] = store.list(noPty);
      expect(resp.ownership).toBe("historical");
      expect(resp.lifecycle).toBe("resumable");
      expect(resp.lifecycleSource).toBe("reconcile");
      expect(resp.ptyAttached).toBe(false);
      // Internal marker — translated into the fields above, never emitted.
      expect(resp).not.toHaveProperty("rehydrated");
    });

    it("prefers resumable over the failed/completed defaults", () => {
      store.addManaged(
        makeManagedSession({ status: "idle", rehydrated: true, failureReason: "boom" }),
      );
      expect(store.list(noPty)[0].lifecycle).toBe("resumable");
    });

    it("leaves a session this run spawned exactly as it was", () => {
      store.addManaged(makeManagedSession({ status: "idle", completedAt: new Date() }));
      const [resp] = store.list(noPty);
      expect(resp.ownership).toBe("managed");
      expect(resp.lifecycle).toBe("completed");
      expect(resp.lifecycleSource).toBe("exit");
    });
  });
});
