import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_test_key_for_offset_detail_tests";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const convId = "offset-detail-session-7777";

function writeFixture(profileDir: string, count: number): void {
  const projDir = join(profileDir, "projects", "-tmp-offset-project");
  mkdirSync(projDir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    lines.push(
      JSON.stringify({
        type: role,
        uuid: `od-${i}`,
        timestamp: `2026-06-05T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(
          i % 60,
        ).padStart(2, "0")}.000Z`,
        sessionId: convId,
        slug: "offset-session",
        cwd: "/tmp/offset-project",
        message: { role, content: [{ type: "text", text: `offset message ${i}` }] },
      }),
    );
  }
  writeFileSync(join(projDir, `${convId}.jsonl`), `${lines.join("\n")}\n`);
}

type DetailBody = {
  messages: Array<{ message_index: number; uuid: string; text: string }>;
  message_pagination: Record<string, unknown>;
};

describe("GET /api/conversations/:id served from the offset index", () => {
  let server: StreamerServer;
  let port: number;

  beforeAll(async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "threadbase-offset-profile-"));
    writeFixture(profileDir, 200);
    port = await getRandomPort();
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-offset-cache-")),
      scanProfiles: [
        { id: "offset", label: "Offset", configDir: profileDir, enabled: true, emoji: "📏" },
      ],
      // Without these the scanner opens its own persistent SQLite index, which
      // leaks real host conversations in and needs a native better-sqlite3 build.
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(port);
  });

  afterAll(async () => {
    await server.close();
  });

  const auth = { Authorization: `Bearer ${API_KEY}` };
  const detail = (params: string) =>
    fetch(`http://localhost:${port}/api/conversations/${convId}?${params}`, { headers: auth });

  async function warmIndex(): Promise<void> {
    // The first paged request triggers a background backfill. Poll a window
    // request until the index is populated and serving (message_index correct).
    for (let attempt = 0; attempt < 40; attempt++) {
      await detail("msg_limit=10");
      const cache = (
        server as unknown as { cache?: { getIndexedMessageCount(id: string): number } }
      ).cache;
      if (cache && cache.getIndexedMessageCount(convId) === 200) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("offset index did not warm up");
  }

  it("backfills the index and serves a tail window with correct message_index + text", async () => {
    await warmIndex();
    const res = await detail("msg_limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailBody;
    // Tail of the last 5 → indexes 195..199, correct uuids and text.
    expect(body.messages.map((m) => m.message_index)).toEqual([195, 196, 197, 198, 199]);
    expect(body.messages.map((m) => m.uuid)).toEqual([
      "od-195",
      "od-196",
      "od-197",
      "od-198",
      "od-199",
    ]);
    expect(body.messages.at(-1)?.text).toBe("offset message 199");
    expect(body.message_pagination.total).toBe(200);
  });

  it("serves an after_index delta window (exactly the requested slice) with an etag cursor token", async () => {
    await warmIndex();
    const res = await detail("after_index=100&msg_limit=4");
    const body = (await res.json()) as DetailBody;
    expect(body.messages.map((m) => m.message_index)).toEqual([100, 101, 102, 103]);
    expect(body.messages.map((m) => m.uuid)).toEqual(["od-100", "od-101", "od-102", "od-103"]);
    // Delta responses carry the conversation etag as a cursor-validity token.
    expect(typeof body.message_pagination.etag).toBe("string");
    expect((body.message_pagination.etag as string).length).toBeGreaterThan(0);
  });

  it("serves a before_index back-page window", async () => {
    await warmIndex();
    const res = await detail("before_index=50&msg_limit=3");
    const body = (await res.json()) as DetailBody;
    // [before_index - limit, before_index) = [47, 50)
    expect(body.messages.map((m) => m.message_index)).toEqual([47, 48, 49]);
  });
});
