import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lastTextMessage } from "../src/utils/lastTextMessage";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean);
const line = (o: unknown) => JSON.stringify(o);

describe("lastTextMessage", () => {
  it("returns the newest Claude assistant text, skipping a later tool_result user line", () => {
    const lines = fixture("contract-tool-use.jsonl").slice(0, 5); // ends on a tool_result
    const last = lastTextMessage(lines);
    expect(last?.role).toBe("assistant");
    expect(last?.timestamp).toBe("2026-01-21T09:00:15.000Z");
    expect(last?.text.length).toBeGreaterThan(0);
  });

  it("returns a user prompt when it is the newest text line", () => {
    const last = lastTextMessage([
      line({
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "fix the build" },
      }),
    ]);
    expect(last).toEqual({
      role: "user",
      text: "fix the build",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });

  it("ignores sidechain, meta and tool-only lines", () => {
    const last = lastTextMessage([
      line({
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "kept" }] },
      }),
      line({
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "subagent" }] },
      }),
      line({
        type: "user",
        isMeta: true,
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: "<command-name>/clear</command-name>" },
      }),
      line({
        type: "assistant",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
        },
      }),
      line({ type: "system", subtype: "turn_duration", timestamp: "2026-01-01T00:00:05.000Z" }),
    ]);
    expect(last?.text).toBe("kept");
  });

  it("truncates to 200 characters", () => {
    const last = lastTextMessage([
      line({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(500) }] },
      }),
    ]);
    expect(last?.text).toHaveLength(200);
  });

  it("returns null for a batch with no text message", () => {
    expect(
      lastTextMessage(fixture("transcript-turn-end/claude-2.1.282-turn-end.jsonl")),
    ).toBeNull();
    expect(lastTextMessage(["not json"])).toBeNull();
  });

  it("reads Codex rollout lines through the client normalizer", () => {
    const last = lastTextMessage(fixture("codex-rollout.jsonl"));
    expect(last?.role).toBe("assistant");
    expect(last?.text).toMatch(/^No security findings\./);
  });
});
