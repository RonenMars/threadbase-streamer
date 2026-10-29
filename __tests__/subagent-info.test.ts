import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSubagentInfo, SUBAGENT_ACTIVE_MS } from "../src/services/conversations/subagentInfo";

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
});
