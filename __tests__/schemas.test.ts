import { describe, expect, it } from "vitest";
import { MessageCursorSchema } from "../src/schemas/messageCursor.schema";

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
