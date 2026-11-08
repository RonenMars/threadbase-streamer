import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_test_key_for_compaction_detail_tests";
const convId = "compaction-detail-session-4242";

const base = { sessionId: convId, cwd: "/tmp/compaction-project", slug: "compaction-session" };
const ts = (s: string) => `2026-05-02T10:${s}.000Z`;
const user = (uuid: string, t: string, text: string, extra: object = {}) => ({
  ...base,
  type: "user",
  uuid,
  timestamp: ts(t),
  message: { role: "user", content: text },
  ...extra,
});
const asst = (uuid: string, t: string, text: string) => ({
  ...base,
  type: "assistant",
  uuid,
  timestamp: ts(t),
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const attachment = (uuid: string, t: string) => ({
  ...base,
  type: "attachment",
  uuid,
  timestamp: ts(t),
  attachment: { type: "todo_reminder", content: [], itemCount: 0 },
});
const boundary = (uuid: string, t: string, trigger: string, pre: number, post: number) => ({
  ...base,
  type: "system",
  subtype: "compact_boundary",
  parentUuid: null,
  uuid,
  timestamp: ts(t),
  compactMetadata: { trigger, preTokens: pre, postTokens: post },
});
const summary = (uuid: string, t: string, text: string) =>
  user(uuid, t, text, { isCompactSummary: true, isVisibleInTranscriptOnly: true });

// An auto-compaction with attachment rows between the boundary and its summary
// (and a summary timestamp earlier than the boundary's), then a manual /compact
// whose summary directly follows the boundary.
const ROWS = [
  user("u1", "00:00", "Plan the lighthouse tour schedule"),
  asst("a1", "00:05", "I'll check the tide table first."),
  boundary("b1", "20:24", "auto", 266000, 28000),
  attachment("t1", "20:24"),
  attachment("t2", "20:24"),
  summary("s1", "20:21", "This session is being continued. The itinerary was drafted."),
  asst("a2", "20:30", "The ferry fits before high tide."),
  user("u2", "30:00", "Add a lunch stop near the harbour"),
  asst("a3", "30:05", "Added a lunch stop at noon."),
  boundary("b2", "40:17", "manual", 120000, 9000),
  summary("s2", "40:17", "This session is being continued. The lunch stop was added."),
  user("u3", "45:00", "Print the final schedule"),
  asst("a4", "45:05", "Here is the final schedule."),
];
// The same list the endpoint served before it knew about compaction: boundary
// and attachment rows emit nothing, every other row keeps its position.
const UUIDS = ["u1", "a1", "s1", "a2", "u2", "a3", "s2", "u3", "a4"];
const AUTO = { trigger: "auto", pre_tokens: 266000, post_tokens: 28000 };
const MANUAL = { trigger: "manual", pre_tokens: 120000, post_tokens: 9000 };

type Message = {
  uuid: string;
  message_index: number;
  role: string;
  is_compact_summary?: boolean;
  compaction?: unknown;
};
type DetailBody = { messages: Message[]; message_pagination?: { total: number } };

function expectCompaction(messages: Message[], offset = 0) {
  expect(messages.map((m) => m.message_index)).toEqual(messages.map((_, i) => offset + i));
  expect(messages.map((m) => m.uuid)).toEqual(UUIDS.slice(offset, offset + messages.length));
  for (const m of messages) {
    if (m.uuid === "s1") {
      expect(m).toMatchObject({ role: "user", is_compact_summary: true, compaction: AUTO });
    } else if (m.uuid === "s2") {
      expect(m).toMatchObject({ role: "user", is_compact_summary: true, compaction: MANUAL });
    } else {
      // Absent, not false or null: an untouched message is byte-identical.
      expect(m).not.toHaveProperty("is_compact_summary");
      expect(m).not.toHaveProperty("compaction");
    }
  }
}

describe("GET /api/conversations/:id with compaction rows", () => {
  let server: StreamerServer;
  let port: number;

  beforeAll(async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "threadbase-compaction-profile-"));
    const projDir = join(profileDir, "projects", "-tmp-compaction-project");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, `${convId}.jsonl`),
      `${ROWS.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-compaction-cache-")),
      scanProfiles: [
        { id: "compaction", label: "Compaction", configDir: profileDir, enabled: true, emoji: "🗜️" },
      ],
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(0, { awaitReady: true });
    port = server.port;
  });

  afterAll(async () => {
    await server.close();
  });

  const detail = async (params: string) => {
    const res = await fetch(`http://localhost:${port}/api/conversations/${convId}?${params}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as DetailBody;
  };

  async function warmIndex(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
      await detail("msg_limit=10");
      const cache = (
        server as unknown as { cache?: { getIndexedMessageCount(id: string): number } }
      ).cache;
      if (cache && cache.getIndexedMessageCount(convId) === UUIDS.length) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("offset index did not warm up");
  }

  it("flags both summaries in the unpaged response without moving any message", async () => {
    expectCompaction((await detail("")).messages);
  });

  it("serves the same flagged messages from the offset index", async () => {
    await warmIndex();
    const body = await detail("msg_limit=50");
    expect(body.message_pagination?.total).toBe(UUIDS.length);
    expectCompaction(body.messages);
  });

  it("carries the boundary numbers when a window opens on the summary row", async () => {
    await warmIndex();
    // The boundary is not a message, so it is outside every index window.
    expectCompaction((await detail("before_index=3&msg_limit=1")).messages, 2);
    expectCompaction((await detail("before_index=7&msg_limit=1")).messages, 6);
  });
});
