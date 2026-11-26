import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readSubagentInfo,
  SUBAGENT_ACTIVE_MS,
  SUBAGENT_BG_WAIT_MAX_MS,
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

  // A sub-agent that starts `sleep N` in the background ends its first run and
  // waits, and Claude marks its sidecar `finished` then. The shapes below are
  // taken from a real 2.1.312 transcript (agent waiting on a 900 s sleep).
  const bgLaunch = (toolId: string, taskId: string) =>
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolId,
            content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/${taskId}.output. You will be notified when it completes.`,
          },
        ],
      },
    });
  const bgDone = (toolId: string, taskId: string) =>
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
      },
    });
  const finishedSidecar = (name: string) =>
    writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify({ finished: true }));

  it("stays active when finished but still waiting on a background task", async () => {
    const f = transcript("bgwait", use("t1"), bgLaunch("t1", "b1"));
    finishedSidecar("bgwait");
    expect((await readSubagentInfo(f, quiet, now)).subagentActive).toBe(true);
  });

  it("is inactive when finished and the background task has reported back", async () => {
    const f = transcript("bgdone", use("t1"), bgLaunch("t1", "b1"), bgDone("t1", "b1"));
    finishedSidecar("bgdone");
    expect((await readSubagentInfo(f, quiet, now)).subagentActive).toBe(false);
  });

  it("stays active while one of two background tasks is still pending", async () => {
    const f = transcript(
      "bg2",
      use("t1"),
      bgLaunch("t1", "b1"),
      use("t2"),
      bgLaunch("t2", "b2"),
      bgDone("t1", "b1"),
    );
    finishedSidecar("bg2");
    expect((await readSubagentInfo(f, quiet, now)).subagentActive).toBe(true);
  });

  it("gives up on a background wait past the cap", async () => {
    const f = transcript("bgstale", use("t1"), bgLaunch("t1", "b1"));
    finishedSidecar("bgstale");
    expect((await readSubagentInfo(f, at(SUBAGENT_BG_WAIT_MAX_MS - 1), now)).subagentActive).toBe(
      true,
    );
    expect((await readSubagentInfo(f, at(SUBAGENT_BG_WAIT_MAX_MS), now)).subagentActive).toBe(
      false,
    );
  });

  it("ignores a background launch when the sidecar does not say finished", async () => {
    // Not finished: the ordinary rules apply, and a closed tool call is quiet.
    const f = transcript("bgnofin", use("t1"), bgLaunch("t1", "b1"));
    expect((await readSubagentInfo(f, quiet, now)).subagentActive).toBe(false);
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
