import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { parseAgentFilterEnv } from "../src/server";
import {
  clearAgentFileCacheForTests,
  isAgentFile,
  isAgentLine,
} from "../src/services/conversations/isAgentConversation";
import { pruneAgentConversations } from "../src/services/conversations/pruneAgentConversations";

let workDir: string;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `agent-filter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workDir, { recursive: true });
  clearAgentFileCacheForTests();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function countRows(cache: ConversationCache): number {
  return cache.listConversations({ limit: 0, offset: 0 }).total;
}

function writeJsonl(name: string, lines: object[]): string {
  const filePath = join(workDir, name);
  writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return filePath;
}

const AGENT_LINE = {
  type: "assistant",
  role: "assistant",
  entrypoint: "sdk-cli",
  cwd: "/private/tmp",
  timestamp: "2026-05-20T15:55:00.000Z",
  message: { role: "assistant", content: "agent says hi" },
};

const HUMAN_LINE = {
  type: "assistant",
  role: "assistant",
  entrypoint: "cli",
  cwd: "/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer",
  timestamp: "2026-05-20T15:55:00.000Z",
  message: { role: "assistant", content: "human says hi" },
};

const HOUSEKEEPING_LINE = {
  type: "queue-operation",
  operation: "enqueue",
  timestamp: "2026-05-20T15:55:00.000Z",
  sessionId: "abc",
};

describe("isAgentLine", () => {
  it("returns true for sdk-cli entrypoint", () => {
    expect(isAgentLine({ entrypoint: "sdk-cli" })).toBe(true);
  });

  it("returns false for cli entrypoint", () => {
    expect(isAgentLine({ entrypoint: "cli" })).toBe(false);
  });

  it("returns false for missing entrypoint (housekeeping lines)", () => {
    expect(isAgentLine({})).toBe(false);
  });
});

describe("isAgentFile", () => {
  it("returns true when JSONL contains sdk-cli marker", () => {
    const fp = writeJsonl("agent.jsonl", [HOUSEKEEPING_LINE, AGENT_LINE]);
    expect(isAgentFile(fp)).toBe(true);
  });

  it("returns false when JSONL contains cli marker", () => {
    const fp = writeJsonl("human.jsonl", [HOUSEKEEPING_LINE, HUMAN_LINE]);
    expect(isAgentFile(fp)).toBe(false);
  });

  it("returns false on empty file", () => {
    const fp = join(workDir, "empty.jsonl");
    writeFileSync(fp, "");
    expect(isAgentFile(fp)).toBe(false);
  });

  it("returns false on nonexistent file", () => {
    expect(isAgentFile(join(workDir, "missing.jsonl"))).toBe(false);
  });

  it("finds marker past the 64 KB chunk boundary (real-world agent files)", () => {
    // Pad with ~150 KB of housekeeping noise so the agent line lands in the
    // third chunk. Matches the on-disk shape of /private/tmp JSONLs where
    // queue-operation / permission-mode prefixes can push entrypoint past
    // 200 KB.
    const filler = Array.from({ length: 1500 }, (_, i) => ({
      ...HOUSEKEEPING_LINE,
      idx: i,
      junk: "x".repeat(100),
    }));
    const fp = writeJsonl("deep-agent.jsonl", [...filler, AGENT_LINE]);
    expect(isAgentFile(fp)).toBe(true);
  });

  it("finds marker straddling a chunk boundary", () => {
    // Write a file where the marker spans the 64 KB boundary. Pad to exactly
    // CHUNK_BYTES - 10 with one line, then write the marker line. This puts
    // the marker bytes 10 in / 12 out, requiring the overlap-carry path.
    const padSize = 64 * 1024 - 10;
    const padding = "x".repeat(padSize);
    const fp = join(workDir, "straddle.jsonl");
    writeFileSync(fp, `${padding}\n${JSON.stringify(AGENT_LINE)}\n`);
    expect(isAgentFile(fp)).toBe(true);
  });
});

describe("parseAgentFilterEnv", () => {
  it("defaults to on when unset", () => {
    expect(parseAgentFilterEnv(undefined)).toBe(true);
  });

  it("treats 0/false/no/off/empty as off", () => {
    for (const v of ["0", "false", "FALSE", "no", "off", " "]) {
      expect(parseAgentFilterEnv(v)).toBe(false);
    }
  });

  it("treats 1/true/yes/on as on", () => {
    for (const v of ["1", "true", "yes", "on", "anything-else"]) {
      expect(parseAgentFilterEnv(v)).toBe(true);
    }
  });
});

describe("ConversationCache filter — watcher path (updateFromLine)", () => {
  it("does NOT create a row for an agent line when filter is on", () => {
    const dbPath = join(workDir, "cache.db");
    const cache = ConversationCache.open(dbPath, 3, undefined, {
      filterAgentConversations: true,
    });
    cache.updateFromLine("/private/tmp/agent-123.jsonl", JSON.stringify(AGENT_LINE));
    expect(countRows(cache)).toBe(0);
    cache.close();
  });

  it("creates a row for a human line when filter is on", () => {
    const dbPath = join(workDir, "cache.db");
    const cache = ConversationCache.open(dbPath, 3, undefined, {
      filterAgentConversations: true,
    });
    cache.updateFromLine("/Users/x/proj/human-123.jsonl", JSON.stringify(HUMAN_LINE));
    expect(countRows(cache)).toBe(1);
    cache.close();
  });

  it("creates a row for an agent line when filter is off (default)", () => {
    const dbPath = join(workDir, "cache.db");
    const cache = ConversationCache.open(dbPath, 3);
    cache.updateFromLine("/private/tmp/agent-123.jsonl", JSON.stringify(AGENT_LINE));
    expect(countRows(cache)).toBe(1);
    cache.close();
  });

  it("fires onAgentFileDetected callback when filter rejects a line", () => {
    const dbPath = join(workDir, "cache.db");
    const seen: string[] = [];
    const cache = ConversationCache.open(dbPath, 3, undefined, {
      filterAgentConversations: true,
      onAgentFileDetected: (fp) => seen.push(fp),
    });
    cache.updateFromLine("/private/tmp/agent-x.jsonl", JSON.stringify(AGENT_LINE));
    expect(seen).toEqual(["/private/tmp/agent-x.jsonl"]);
    cache.close();
  });
});

describe("ConversationCache filter — scanner path (upsertFromScannerMeta)", () => {
  it("skips agent JSONLs when filter is on", () => {
    const agentFp = writeJsonl("agent.jsonl", [AGENT_LINE]);
    const humanFp = writeJsonl("human.jsonl", [HUMAN_LINE]);
    const dbPath = join(workDir, "cache.db");
    const cache = ConversationCache.open(dbPath, 3, undefined, {
      filterAgentConversations: true,
    });
    cache.upsertFromScannerMeta([
      { id: "a", sessionId: "a", filePath: agentFp } as never,
      { id: "h", sessionId: "h", filePath: humanFp } as never,
    ]);
    expect(countRows(cache)).toBe(1);
    cache.close();
  });

  it("ingests both when filter is off (default)", () => {
    const agentFp = writeJsonl("agent.jsonl", [AGENT_LINE]);
    const humanFp = writeJsonl("human.jsonl", [HUMAN_LINE]);
    const dbPath = join(workDir, "cache.db");
    const cache = ConversationCache.open(dbPath, 3);
    cache.upsertFromScannerMeta([
      { id: "a", sessionId: "a", filePath: agentFp } as never,
      { id: "h", sessionId: "h", filePath: humanFp } as never,
    ]);
    expect(countRows(cache)).toBe(2);
    cache.close();
  });
});

describe("pruneAgentConversations", () => {
  it("deletes rows for agent JSONLs and leaves human rows untouched", () => {
    const agentFp = writeJsonl("agent.jsonl", [AGENT_LINE]);
    const humanFp = writeJsonl("human.jsonl", [HUMAN_LINE]);
    const dbPath = join(workDir, "cache.db");
    // Open WITHOUT filter so both rows go in, then run prune.
    const cache = ConversationCache.open(dbPath, 3);
    cache.upsertFromScannerMeta([
      { id: "agent", sessionId: "agent", filePath: agentFp } as never,
      { id: "human", sessionId: "human", filePath: humanFp } as never,
    ]);
    expect(countRows(cache)).toBe(2);

    const result = pruneAgentConversations(cache);
    expect(result.scanned).toBe(2);
    expect(result.pruned).toBe(1);
    expect(result.missing).toBe(0);
    expect(countRows(cache)).toBe(1);

    // Idempotent: second run finds nothing to prune.
    const second = pruneAgentConversations(cache);
    expect(second.pruned).toBe(0);

    cache.close();
  });

  it("counts missing files separately from agent files", () => {
    const humanFp = writeJsonl("human.jsonl", [HUMAN_LINE]);
    const dbPath = join(workDir, "cache.db");
    const cache = ConversationCache.open(dbPath, 3);
    cache.upsertFromScannerMeta([
      { id: "human", sessionId: "human", filePath: humanFp } as never,
      { id: "gone", sessionId: "gone", filePath: join(workDir, "deleted.jsonl") } as never,
    ]);

    const result = pruneAgentConversations(cache);
    expect(result.scanned).toBe(2);
    expect(result.pruned).toBe(0);
    expect(result.missing).toBe(1);
    // The missing-file row is left in place — we only remove agent rows.
    expect(countRows(cache)).toBe(2);

    cache.close();
  });
});
