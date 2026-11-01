import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { clearAgentFileCacheForTests } from "../src/services/conversations/isAgentConversation";

let workDir: string;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `agent-probe-codex-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workDir, { recursive: true });
  clearAgentFileCacheForTests();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// A line carrying a raw agent marker. Real Codex rollouts never contain one
// (tool output is JSON-escaped, so `\"entrypoint\":` does not match), which is
// what lets the probe skip them: the marker here is the observable stand-in for
// "the probe read this file".
const MARKED = `${JSON.stringify({ type: "response_item", payload: { entrypoint: "sdk-cli" } })}\n`;

function write(name: string): string {
  const filePath = join(workDir, name);
  writeFileSync(filePath, MARKED);
  return filePath;
}

describe("agent probe on Codex rollouts", () => {
  it("does not read a rollout-*.jsonl file", () => {
    const cache = ConversationCache.open(join(workDir, "cache.db"), 3);
    expect(cache.isAgentFileCached(write("rollout-2026-11-02T00-00-00-abc.jsonl"))).toBe(false);
    cache.close();
  });

  it("still reads any other JSONL (control: the marker is detectable)", () => {
    const cache = ConversationCache.open(join(workDir, "cache.db"), 3);
    expect(cache.isAgentFileCached(write("session.jsonl"))).toBe(true);
    cache.close();
  });
});
