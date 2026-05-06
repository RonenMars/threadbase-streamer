import { describe, expect, it } from "vitest";
import { MessageCursorSchema } from "../src/schemas/messageCursor.schema";
import { ProjectChatSchema } from "../src/schemas/projectChat.schema";
import { ListProjectChatsQuerySchema } from "../src/schemas/queryParams.schema";

describe("ListProjectChatsQuerySchema", () => {
  it("accepts empty params", () => {
    expect(ListProjectChatsQuerySchema.parse({})).toEqual({});
  });

  it("accepts refresh=1", () => {
    expect(ListProjectChatsQuerySchema.parse({ refresh: "1" })).toEqual({ refresh: "1" });
  });

  it("accepts refreshConversations=1", () => {
    expect(ListProjectChatsQuerySchema.parse({ refreshConversations: "1" })).toEqual({
      refreshConversations: "1",
    });
  });

  it("rejects refresh values other than 1", () => {
    expect(ListProjectChatsQuerySchema.safeParse({ refresh: "true" }).success).toBe(false);
  });
});

describe("MessageCursorSchema", () => {
  it("accepts a valid cursor", () => {
    expect(
      MessageCursorSchema.parse({
        timestamp: "2024-01-01T00:00:00.000Z",
        id: "msg-1",
      }),
    ).toEqual({ timestamp: "2024-01-01T00:00:00.000Z", id: "msg-1" });
  });

  it("rejects bad timestamp", () => {
    expect(MessageCursorSchema.safeParse({ timestamp: "yesterday", id: "msg-1" }).success).toBe(
      false,
    );
  });

  it("rejects empty id", () => {
    expect(
      MessageCursorSchema.safeParse({ timestamp: "2024-01-01T00:00:00.000Z", id: "" }).success,
    ).toBe(false);
  });
});

describe("ProjectChatSchema", () => {
  it("validates a session variant", () => {
    const chat = {
      type: "session",
      id: "s-1",
      projectId: "p-1",
      projectPath: "/a",
      title: "Demo",
      latestMessageAt: null,
      status: "active",
      source: "session-store",
    };
    expect(ProjectChatSchema.parse(chat)).toMatchObject({ type: "session", id: "s-1" });
  });

  it("validates a conversation variant", () => {
    const chat = {
      type: "conversation",
      id: "c-1",
      projectId: "p-1",
      projectPath: "/a",
      title: "Demo",
      latestMessageAt: null,
      status: "resumable",
      source: "hdd-cache",
    };
    expect(ProjectChatSchema.parse(chat)).toMatchObject({ type: "conversation", id: "c-1" });
  });

  it("rejects mismatched discriminator/source", () => {
    const bad = {
      type: "session",
      id: "s-1",
      projectId: "p-1",
      title: "Demo",
      latestMessageAt: null,
      status: "active",
      source: "hdd-cache", // wrong for session
    };
    expect(ProjectChatSchema.safeParse(bad).success).toBe(false);
  });
});
