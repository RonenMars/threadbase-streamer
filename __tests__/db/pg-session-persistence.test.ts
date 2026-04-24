import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "../../src/types";

const mockQuery = vi.fn();
const mockPool = { query: mockQuery };

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
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

import { PgSessionPersistence } from "../../src/db/pg-session-persistence";

describe("PgSessionPersistence", () => {
  let persistence: PgSessionPersistence;

  beforeEach(() => {
    mockQuery.mockReset();
    persistence = new PgSessionPersistence(mockPool as any);
  });

  describe("save", () => {
    it("inserts a managed session with parameterized query", async () => {
      mockQuery.mockResolvedValueOnce({});
      const session = makeSession();

      await persistence.save(session);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("INSERT INTO managed_sessions");
      expect(sql).toContain("$1");
      expect(params).toContain("ses_abc123");
      expect(params).toContain("conv_xyz");
      expect(params).toContain("/tmp/project");
      expect(params).toContain("project");
      expect(params).toContain("main");
      expect(params).toContain("running");
    });

    it("uses ON CONFLICT to upsert", async () => {
      mockQuery.mockResolvedValueOnce({});
      await persistence.save(makeSession());

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain("ON CONFLICT");
    });
  });

  describe("update", () => {
    it("updates only provided fields", async () => {
      mockQuery.mockResolvedValueOnce({});

      await persistence.update("ses_abc123", {
        status: "completed",
        completedAt: new Date("2026-04-18T10:05:00Z"),
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("UPDATE managed_sessions");
      expect(sql).toContain("WHERE id = ");
      expect(params).toContain("ses_abc123");
    });

    it("does nothing when updates object is empty", async () => {
      await persistence.update("ses_abc123", {});
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes by session id with parameterized query", async () => {
      mockQuery.mockResolvedValueOnce({});

      await persistence.remove("ses_abc123");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("DELETE FROM managed_sessions");
      expect(params).toEqual(["ses_abc123"]);
    });
  });

  describe("loadAll", () => {
    it("returns deserialized ManagedSession objects", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "ses_abc123",
            conversation_id: "conv_xyz",
            project_path: "/tmp/project",
            project_name: "project",
            branch: "main",
            status: "running",
            started_at: new Date("2026-04-18T10:00:00Z"),
            completed_at: null,
            prompt_count: 0,
            last_output: "",
          },
        ],
      });

      const sessions = await persistence.loadAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses_abc123");
      expect(sessions[0].conversationId).toBe("conv_xyz");
      expect(sessions[0].projectPath).toBe("/tmp/project");
      expect(sessions[0].startedAt).toEqual(new Date("2026-04-18T10:00:00Z"));
      expect(sessions[0].completedAt).toBeNull();
    });

    it("returns empty array when no rows", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const sessions = await persistence.loadAll();
      expect(sessions).toEqual([]);
    });
  });
});
