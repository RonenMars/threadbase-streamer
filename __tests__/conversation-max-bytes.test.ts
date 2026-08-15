import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

/**
 * `max_bytes` bounds a page by what it actually costs on the wire rather than
 * by a message count. A count says nothing about size — the same 500 messages
 * span two orders of magnitude across real conversations — and the budget
 * exists to keep a session's opening fetch off a phone's heap.
 *
 * The oldest messages of the page are dropped, never the newest: the client
 * wants the tail and pages backward from it.
 */

const API_KEY = "tb_test_key_for_max_bytes_tests";
const ASCII_ID = "max-bytes-ascii-1111";
const HEBREW_ID = "max-bytes-hebrew-2222";
const SHORT_ID = "max-bytes-short-3333";
const HUGE_ID = "max-bytes-huge-4444";

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

function jsonl(convId: string, count: number, text: (i: number) => string): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    lines.push(
      `${JSON.stringify({
        type: role,
        uuid: `${convId}-${i}`,
        timestamp: `2026-08-15T09:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(
          i % 60,
        ).padStart(2, "0")}.000Z`,
        sessionId: convId,
        slug: "max-bytes-session",
        cwd: "/tmp/max-bytes-project",
        message: {
          role,
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: text(i) }],
        },
      })}\n`,
    );
  }
  return lines.join("");
}

function writeFixtures(profileDir: string): void {
  const projDir = join(profileDir, "projects", "-tmp-max-bytes-project");
  mkdirSync(projDir, { recursive: true });
  // ~500 ASCII chars per message → ~500 bytes of text each.
  writeFileSync(
    join(projDir, `${ASCII_ID}.jsonl`),
    jsonl(ASCII_ID, 200, (i) => `${i} ${"a".repeat(500)}`),
  );
  // Hebrew is 2 bytes per character in UTF-8, so a budget counted in UTF-16
  // string length would admit roughly twice as many messages as it should.
  writeFileSync(
    join(projDir, `${HEBREW_ID}.jsonl`),
    jsonl(HEBREW_ID, 200, (i) => `${i} ${"ש".repeat(500)}`),
  );
  // Whole conversation well under any budget used here.
  writeFileSync(
    join(projDir, `${SHORT_ID}.jsonl`),
    jsonl(SHORT_ID, 5, (i) => `short ${i}`),
  );
  // A single message larger than the budget the test asks for.
  writeFileSync(
    join(projDir, `${HUGE_ID}.jsonl`),
    jsonl(HUGE_ID, 1, () => "z".repeat(50_000)),
  );
}

type DetailBody = {
  messages: Array<{ message_index: number; text: string }>;
  message_pagination: Record<string, unknown>;
};

describe("GET /api/conversations/:id?max_bytes", () => {
  let server: StreamerServer;
  let port: number;

  beforeAll(async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "threadbase-max-bytes-profile-"));
    writeFixtures(profileDir);
    port = await getRandomPort();
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-max-bytes-cache-")),
      scanProfiles: [
        { id: "maxbytes", label: "MaxBytes", configDir: profileDir, enabled: true, emoji: "📏" },
      ],
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(port, { awaitReady: true });
  });

  afterAll(async () => {
    await server.close();
  });

  const detail = async (id: string, params: string): Promise<DetailBody> => {
    const res = await fetch(`http://localhost:${port}/api/conversations/${id}?${params}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as DetailBody;
  };

  // The positive control. Without it, an implementation that trims EVERY page
  // to its newest message passes every budget assertion below.
  it("serves the full page when no budget is given", async () => {
    const body = await detail(ASCII_ID, "msg_limit=200");
    expect(body.messages.length).toBe(200);
    expect(body.message_pagination.from_index).toBe(0);
    expect(body.message_pagination.has_more_older).toBe(false);
    expect(body.message_pagination.served_bytes).toBeUndefined();
  });

  it("drops the oldest messages of the page until the rest fit the budget", async () => {
    const budget = 20_000;
    const body = await detail(ASCII_ID, `msg_limit=200&max_bytes=${budget}`);

    // Trimmed, but not to nothing.
    expect(body.messages.length).toBeGreaterThan(1);
    expect(body.messages.length).toBeLessThan(200);
    // The NEWEST messages survive — this is the assertion the whole feature is
    // about, and a count-only check passes whichever end got dropped.
    expect(body.messages.at(-1)?.message_index).toBe(199);
    expect(body.messages[0]?.message_index).toBe(200 - body.messages.length);
    expect(body.message_pagination.served_bytes as number).toBeLessThanOrEqual(budget);
  });

  it("moves the cursor to the trimmed page's start so older messages stay reachable", async () => {
    const body = await detail(ASCII_ID, "msg_limit=200&max_bytes=20000");
    const from = body.message_pagination.from_index as number;

    expect(from).toBe(body.messages[0]?.message_index);
    expect(body.message_pagination.has_more_older).toBe(true);
    expect(body.message_pagination.next_before_index).toBe(from);

    // The seam: the older page ends exactly where this one starts. A cursor
    // left at the untrimmed start would silently skip everything trimmed.
    const older = await detail(ASCII_ID, `msg_limit=50&before_index=${from}`);
    expect(older.messages.at(-1)?.message_index).toBe(from - 1);
  });

  it("counts bytes, not UTF-16 length, so non-ASCII conversations stay within budget", async () => {
    const budget = 20_000;
    const body = await detail(HEBREW_ID, `msg_limit=200&max_bytes=${budget}`);
    // Serialized size of what was actually returned, measured independently of
    // whatever the server reported. Counting `.length` would admit ~2x the
    // messages and overshoot the budget by the same factor.
    expect(Buffer.byteLength(JSON.stringify(body.messages))).toBeLessThanOrEqual(budget);
  });

  it("serves a whole conversation that fits, with the cursor at the start", async () => {
    const body = await detail(SHORT_ID, "msg_limit=200&max_bytes=524288");
    expect(body.messages.length).toBe(5);
    expect(body.message_pagination.from_index).toBe(0);
    expect(body.message_pagination.has_more_older).toBe(false);
    expect(body.message_pagination.next_before_index).toBeNull();
    expect(body.message_pagination.served_bytes as number).toBeGreaterThan(0);
  });

  it("serves an over-budget single message rather than an empty page", async () => {
    const body = await detail(HUGE_ID, "msg_limit=200&max_bytes=1000");
    expect(body.messages.length).toBe(1);
    expect(body.message_pagination.served_bytes as number).toBeGreaterThan(1000);
  });
});
