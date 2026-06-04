// __tests__/agent/conversation-writer.test.ts
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConversationWriter,
  createConversationWriter,
} from "../../src/agent/conversation-writer";

describe("ConversationWriter", () => {
  let dir: string;
  let writer: ConversationWriter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tb-jsonl-"));
    writer = createConversationWriter({ baseDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a JSON line per assistant turn", async () => {
    await writer.appendAssistantTurn({
      sessionId: "sess_1",
      turnId: "turn_1",
      content: "hello world",
    });
    const file = join(dir, "sess_1.jsonl");
    const text = await readFile(file, "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(text.trim());
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toBe("hello world");
    expect(parsed.turnId).toBe("turn_1");
    expect(typeof parsed.timestamp).toBe("number");
  });

  it("appends multiple turns to the same file", async () => {
    await writer.appendAssistantTurn({
      sessionId: "sess_2",
      turnId: "t1",
      content: "a",
    });
    await writer.appendAssistantTurn({
      sessionId: "sess_2",
      turnId: "t2",
      content: "b",
    });
    const text = await readFile(join(dir, "sess_2.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).turnId).toBe("t1");
    expect(JSON.parse(lines[1]).turnId).toBe("t2");
  });

  it("carries reviewerOverruled when set", async () => {
    await writer.appendAssistantTurn({
      sessionId: "sess_3",
      turnId: "t",
      content: "answer",
      reviewerOverruled: true,
    });
    const parsed = JSON.parse((await readFile(join(dir, "sess_3.jsonl"), "utf8")).trim());
    expect(parsed.reviewerOverruled).toBe(true);
  });

  it("creates the directory if it does not exist", async () => {
    const nested = join(dir, "deep", "nest");
    const w = createConversationWriter({ baseDir: nested });
    await w.appendAssistantTurn({ sessionId: "x", turnId: "y", content: "z" });
    const s = await stat(join(nested, "x.jsonl"));
    expect(s.isFile()).toBe(true);
  });

  it("escapes newlines and quotes safely", async () => {
    await writer.appendAssistantTurn({
      sessionId: "sess_e",
      turnId: "t",
      content: 'has "quotes"\nand a newline',
    });
    const text = await readFile(join(dir, "sess_e.jsonl"), "utf8");
    // The file must still be valid JSONL — one line, one JSON object.
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.content).toContain("newline");
  });

  it("rejects an empty content with a clear error (do not write empty assistant turns)", async () => {
    await expect(
      writer.appendAssistantTurn({ sessionId: "s", turnId: "t", content: "" }),
    ).rejects.toThrow(/empty/i);
  });
});
