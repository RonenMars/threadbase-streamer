import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readSubagentInfo,
  SUBAGENT_ACTIVE_MS,
  SUBAGENT_TOOL_CALL_MAX_MS,
} from "../src/services/conversations/subagentInfo";

describe("readSubagentInfo", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagent-info-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const now = Date.parse("2026-10-25T10:00:00.000Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("reads the Claude sidecar next to the transcript", async () => {
    const file = join(dir, "agent-a1.jsonl");
    writeFileSync(
      join(dir, "agent-a1.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "/code-review", name: "cr" }),
    );
    expect(await readSubagentInfo(file, at(1000), now)).toEqual({
      subagentType: "general-purpose",
      subagentDescription: "/code-review",
      subagentName: "cr",
      subagentActive: true,
    });
  });

  it("gives liveness only when there is no sidecar (Codex, Cursor)", async () => {
    expect(await readSubagentInfo(join(dir, "x.jsonl"), at(1000), now)).toEqual({
      subagentActive: true,
    });
  });

  it("survives a malformed sidecar", async () => {
    writeFileSync(join(dir, "bad.meta.json"), "{not json");
    expect(await readSubagentInfo(join(dir, "bad.jsonl"), at(0), now)).toEqual({
      subagentActive: true,
    });
  });

  it("flips to inactive at the activity window", async () => {
    const f = join(dir, "y.jsonl");
    expect((await readSubagentInfo(f, at(SUBAGENT_ACTIVE_MS - 1), now)).subagentActive).toBe(true);
    expect((await readSubagentInfo(f, at(SUBAGENT_ACTIVE_MS), now)).subagentActive).toBe(false);
  });

  // Line shapes match a Claude Code 2.1.312 sub-agent transcript: one content
  // block per assistant line, results on user lines.
  const use = (id: string) =>
    JSON.stringify({
      type: "assistant",
      message: { stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "Bash" }] },
    });
  const result = (id: string) =>
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id }] },
    });
  const transcript = (name: string, ...lines: string[]) => {
    const f = join(dir, `${name}.jsonl`);
    writeFileSync(
      f,
      `${JSON.stringify({ type: "user", message: { content: "go" } })}\n${lines.join("\n")}\n`,
    );
    return f;
  };
  const quiet = at(SUBAGENT_ACTIVE_MS + 30_000);

  it("is inactive as soon as the sidecar says finished, however recent the write", async () => {
    const f = transcript("fin", use("t1"));
    writeFileSync(
      join(dir, "fin.meta.json"),
      JSON.stringify({ agentType: "Explore", finished: true }),
    );
    expect((await readSubagentInfo(f, at(0), now)).subagentActive).toBe(false);
  });

  it("stays active through a long tool call that has no result yet", async () => {
    const f = transcript("open", use("t1"), result("t1"), use("t2"));
    expect((await readSubagentInfo(f, quiet, now)).subagentActive).toBe(true);
  });

  it("stays active while one of two parallel tool calls is still open", async () => {
    const f = transcript("par", use("t1"), use("t2"), result("t2"));
    expect((await readSubagentInfo(f, quiet, now)).subagentActive).toBe(true);
  });

  it("is inactive when quiet and every tool call has its result", async () => {
    const f = transcript("closed", use("t1"), result("t1"));
    expect((await readSubagentInfo(f, quiet, now)).subagentActive).toBe(false);
  });

  it("gives up on an open tool call past the cap", async () => {
    const f = transcript("stale", use("t1"));
    expect((await readSubagentInfo(f, at(SUBAGENT_TOOL_CALL_MAX_MS - 1), now)).subagentActive).toBe(
      true,
    );
    expect((await readSubagentInfo(f, at(SUBAGENT_TOOL_CALL_MAX_MS), now)).subagentActive).toBe(
      false,
    );
  });
});
