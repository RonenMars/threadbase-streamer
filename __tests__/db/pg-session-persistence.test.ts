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

    it("includes conversation metadata columns in insert", async () => {
      mockQuery.mockResolvedValueOnce({});
      await persistence.save(makeSession());

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("session_name");
      expect(sql).toContain("model");
      expect(sql).toContain("file_path");
      expect(params).toContain("test-session");
      expect(params).toContain("claude-opus-4-6");
      expect(params).toContain("/tmp/conv.jsonl");
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
    it("returns deserialized ManagedSession objects with metadata", async () => {
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
            session_name: "test-session",
            model: "claude-opus-4-6",
            account: "default",
            message_count: 42,
            preview: "Hello world",
            first_message_text: "Hi there",
            first_message_at: new Date("2026-04-18T09:55:00Z"),
            last_message_text: "Goodbye",
            last_message_at: new Date("2026-04-18T10:00:00Z"),
            file_path: "/tmp/conv.jsonl",
          },
        ],
      });
      const sessions = await persistence.loadAll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionName).toBe("test-session");
      expect(sessions[0].model).toBe("claude-opus-4-6");
      expect(sessions[0].messageCount).toBe(42);
      expect(sessions[0].firstMessageText).toBe("Hi there");
      expect(sessions[0].filePath).toBe("/tmp/conv.jsonl");
    });

    it("handles null metadata fields from DB", async () => {
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
            session_name: null,
            model: null,
            account: null,
            message_count: 0,
            preview: null,
            first_message_text: null,
            first_message_at: null,
            last_message_text: null,
            last_message_at: null,
            file_path: null,
          },
        ],
      });
      const sessions = await persistence.loadAll();
      expect(sessions[0].sessionName).toBeUndefined();
      expect(sessions[0].model).toBeUndefined();
      expect(sessions[0].filePath).toBeUndefined();
    });

    it("returns empty array when no rows", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const sessions = await persistence.loadAll();
      expect(sessions).toEqual([]);
    });
  });
});
