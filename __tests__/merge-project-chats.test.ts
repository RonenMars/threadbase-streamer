import { describe, expect, it } from "vitest";
import type { ProjectChat } from "../src/schemas/projectChat.schema";
import { mergeProjectChats } from "../src/services/projectChats/mergeProjectChats";

const session = (overrides: Partial<Extract<ProjectChat, { type: "session" }>>): ProjectChat => ({
  type: "session",
  id: "s",
  projectId: "p",
  projectPath: "/a",
  title: "session",
  latestMessageAt: null,
  status: "active",
  source: "session-store",
  ...overrides,
});

const conversation = (
  overrides: Partial<Extract<ProjectChat, { type: "conversation" }>>,
): ProjectChat => ({
  type: "conversation",
  id: "c",
  projectId: "p",
  projectPath: "/a",
  title: "conversation",
  latestMessageAt: null,
  status: "resumable",
  source: "hdd-cache",
  ...overrides,
});

describe("mergeProjectChats", () => {
  it("hides conversations resumed into an active session", () => {
    const sessions = [session({ id: "s1", resumedFromConversationId: "c1" })];
    const conversations = [conversation({ id: "c1" }), conversation({ id: "c2" })];
    const merged = mergeProjectChats({ sessions, conversations });
    expect(merged.map((c) => c.id).sort()).toEqual(["c2", "s1"]);
  });

  it("sorts by latestMessageAt DESC", () => {
    const merged = mergeProjectChats({
      sessions: [],
      conversations: [
        conversation({ id: "old", latestMessageAt: "2024-01-01T00:00:00.000Z" }),
        conversation({ id: "new", latestMessageAt: "2024-06-01T00:00:00.000Z" }),
      ],
    });
    expect(merged[0].id).toBe("new");
    expect(merged[1].id).toBe("old");
  });

  it("falls back to title ASC when timestamps are absent", () => {
    const merged = mergeProjectChats({
      sessions: [],
      conversations: [
        conversation({ id: "z", title: "Zeta" }),
        conversation({ id: "a", title: "Alpha" }),
      ],
    });
    expect(merged[0].title).toBe("Alpha");
    expect(merged[1].title).toBe("Zeta");
  });
});
