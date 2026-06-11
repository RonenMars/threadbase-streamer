import { describe, expect, it } from "vitest";
import { computeConversationEtag } from "../src/utils/conversationEtag";

describe("computeConversationEtag", () => {
  const base = {
    filePath: "/home/user/.claude/projects/foo/abc.jsonl",
    messageCount: 10,
    timestamp: "2026-06-10T12:00:00.000Z",
  };

  it("is stable for the same input", () => {
    expect(computeConversationEtag(base)).toBe(computeConversationEtag(base));
  });

  it("returns an opaque, double-quoted, bounded value", () => {
    const etag = computeConversationEtag(base);
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it("differs when the message count changes", () => {
    expect(computeConversationEtag(base)).not.toBe(
      computeConversationEtag({ ...base, messageCount: 11 }),
    );
  });

  it("differs when the timestamp changes", () => {
    expect(computeConversationEtag(base)).not.toBe(
      computeConversationEtag({ ...base, timestamp: "2026-06-10T12:00:01.000Z" }),
    );
  });

  it("differs when the file path changes", () => {
    expect(computeConversationEtag(base)).not.toBe(
      computeConversationEtag({ ...base, filePath: "/other/def.jsonl" }),
    );
  });
});
