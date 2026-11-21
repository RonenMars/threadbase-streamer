import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationCache } from "../src/conversation-cache";

// `onSubagentRow` is what turns a child write into a `subagents_changed` frame,
// so each way a child row can be written must name its parent, and an ordinary
// conversation must not.
let dir: string;
let cache: ConversationCache;
let seen: string[];

const user = { type: "user", message: { role: "user", content: "hello" } };
const child = (agentId: string) => ({ ...user, isSidechain: true, agentId, sessionId: "parent" });
const jsonl = (entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cache-subagent-row-"));
  seen = [];
  cache = ConversationCache.open(join(dir, "cache.db"), 10, undefined, {
    onSubagentRow: (parentId) => seen.push(parentId),
  });
});
afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

const scan = (id: string, entries: unknown[]) => {
  const filePath = join(dir, `${id}.jsonl`);
  writeFileSync(filePath, jsonl(entries));
  cache.upsertFromScannerMeta([
    { id, sessionId: id, filePath, projectPath: "/repo", projectName: "repo", messageCount: 1 },
  ]);
  return filePath;
};

it("names the parent when the scanner upserts a sub-agent", () => {
  scan("agent-a", [child("a")]);
  expect(seen).toEqual(["parent"]);
});

it("names the parent when a sub-agent's live tail writes its row", () => {
  const filePath = join(dir, "agent-b.jsonl");
  writeFileSync(filePath, "");
  cache.updateFromLines(filePath, [JSON.stringify(child("b"))]);
  expect(seen).toContain("parent");
});

it("stays silent for an ordinary conversation", () => {
  const filePath = scan("ordinary", [user]);
  cache.updateFromLines(filePath, [JSON.stringify(user)]);
  expect(seen).toEqual([]);
});

it("names the parent when reclassification turns a row into a sub-agent", () => {
  const filePath = scan("agent-c", [user]);
  expect(seen).toEqual([]);
  writeFileSync(filePath, jsonl([child("c")]));
  cache.reconcileClassification(filePath);
  expect(seen).toContain("parent");
});
