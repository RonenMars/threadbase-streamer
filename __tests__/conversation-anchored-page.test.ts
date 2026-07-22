import { ConversationScanner } from "@threadbase-sh/scanner";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_test_key_for_anchored_page_tests";

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

const convId = "anchored-page-session-5555";

function writeFixture(profileDir: string): void {
  const projDir = join(profileDir, "projects", "-tmp-anchored-project");
  mkdirSync(projDir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    lines.push(
      `${JSON.stringify({
        type: role,
        uuid: `an-${i}`,
        timestamp: `2026-06-05T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(
          i % 60,
        ).padStart(2, "0")}.000Z`,
        sessionId: convId,
        slug: "anchored-session",
        cwd: "/tmp/anchored-project",
        message: {
          role,
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: `anchored message ${i}` }],
        },
      })}\n`,
    );
  }
  writeFileSync(join(projDir, `${convId}.jsonl`), lines.join(""));
}

type DetailBody = {
  messages: Array<{ message_index: number }>;
  message_pagination: Record<string, unknown>;
};

describe("GET /api/conversations/:id anchored and after windows", () => {
  let server: StreamerServer;
  let port: number;

  beforeAll(async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "threadbase-anchored-profile-"));
    writeFixture(profileDir);
    port = await getRandomPort();
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-anchored-cache-")),
      scanProfiles: [
        { id: "anchored", label: "Anchored", configDir: profileDir, enabled: true, emoji: "⚓" },
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
  const detail = (params: string, headers: Record<string, string> = {}) =>
    fetch(`http://localhost:${port}/api/conversations/${convId}?${params}`, {
      headers: { ...auth, ...headers },
    });

  function indexes(body: DetailBody): number[] {
    return body.messages.map((m) => m.message_index);
  }

  it("centers the window on a mid-conversation anchor", async () => {
    const res = await detail("msg_limit=120&anchor_index=150");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailBody;
    expect(body.message_pagination).toEqual({
      total: 300,
      before_index: 210,
      from_index: 90,
      has_more_older: true,
      next_before_index: 90,
      anchor_index: 150,
      has_more_newer: true,
      next_after_index: 210,
    });
    const idx = indexes(body);
    expect(idx.length).toBe(120);
    expect(idx[0]).toBe(90);
    expect(idx[idx.length - 1]).toBe(209);
    expect(idx).toContain(150);
  });

  it("clamps the window to the start for an early anchor", async () => {
    const res = await detail("msg_limit=120&anchor_index=10");
    const body = (await res.json()) as DetailBody;
    expect(body.message_pagination).toEqual({
      total: 300,
      before_index: 120,
      from_index: 0,
      has_more_older: false,
      next_before_index: null,
      anchor_index: 10,
      has_more_newer: true,
      next_after_index: 120,
    });
    expect(indexes(body)[0]).toBe(0);
  });

  it("widens the window backward for an anchor near the tail", async () => {
    const res = await detail("msg_limit=120&anchor_index=290");
    const body = (await res.json()) as DetailBody;
    expect(body.message_pagination).toEqual({
      total: 300,
      before_index: 300,
      from_index: 180,
      has_more_older: true,
      next_before_index: 180,
      anchor_index: 290,
      has_more_newer: false,
      next_after_index: null,
    });
    const idx = indexes(body);
    expect(idx[0]).toBe(180);
    expect(idx[idx.length - 1]).toBe(299);
  });

  it("clamps out-of-range anchors instead of erroring", async () => {
    const low = await detail("msg_limit=120&anchor_index=-5");
    expect(low.status).toBe(200);
    const lowBody = (await low.json()) as DetailBody;
    expect(lowBody.message_pagination.anchor_index).toBe(0);
    expect(lowBody.message_pagination.from_index).toBe(0);

    const high = await detail("msg_limit=120&anchor_index=5000");
    expect(high.status).toBe(200);
    const highBody = (await high.json()) as DetailBody;
    expect(highBody.message_pagination.anchor_index).toBe(299);
    expect(highBody.message_pagination.from_index).toBe(180);
    expect(highBody.message_pagination.before_index).toBe(300);
  });

  it("returns the newer window [after_index, after_index + msg_limit)", async () => {
    const res = await detail("msg_limit=120&after_index=210");
    const body = (await res.json()) as DetailBody;
    expect(body.message_pagination).toEqual({
      total: 300,
      before_index: 300,
      from_index: 210,
      has_more_older: true,
      next_before_index: 210,
      has_more_newer: false,
      next_after_index: null,
      // after_index responses carry the conversation etag as a cursor token.
      etag: expect.any(String),
    });
    const idx = indexes(body);
    expect(idx.length).toBe(90);
    expect(idx[0]).toBe(210);
    expect(idx[idx.length - 1]).toBe(299);
  });

  it("reports has_more_newer with the next cursor on a non-final after window", async () => {
    const res = await detail("msg_limit=120&after_index=60");
    const body = (await res.json()) as DetailBody;
    expect(body.message_pagination.from_index).toBe(60);
    expect(body.message_pagination.before_index).toBe(180);
    expect(body.message_pagination.has_more_newer).toBe(true);
    expect(body.message_pagination.next_after_index).toBe(180);
    expect(indexes(body).length).toBe(120);
  });

  it("returns an empty page for an after_index at or past the tail", async () => {
    for (const after of [300, 5000]) {
      const res = await detail(`msg_limit=120&after_index=${after}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DetailBody;
      expect(body.messages).toEqual([]);
      expect(body.message_pagination.from_index).toBe(300);
      expect(body.message_pagination.before_index).toBe(300);
      expect(body.message_pagination.has_more_newer).toBe(false);
      expect(body.message_pagination.next_after_index).toBeNull();
    }
  });

  it("gives before_index precedence over anchor_index and after_index", async () => {
    const res = await detail("msg_limit=37&before_index=211&anchor_index=150&after_index=10");
    const body = (await res.json()) as DetailBody;
    expect(body.message_pagination).toEqual({
      total: 300,
      before_index: 211,
      from_index: 174,
      has_more_older: true,
      next_before_index: 174,
    });
    expect(body.message_pagination).not.toHaveProperty("anchor_index");
    expect(body.message_pagination).not.toHaveProperty("has_more_newer");
  });

  it("gives after_index precedence over anchor_index", async () => {
    const res = await detail("msg_limit=120&after_index=210&anchor_index=150");
    const body = (await res.json()) as DetailBody;
    expect(body.message_pagination.from_index).toBe(210);
    expect(body.message_pagination).not.toHaveProperty("anchor_index");
  });

  it("keeps the plain paged shape byte-compatible (no new keys)", async () => {
    const res = await detail("msg_limit=80");
    const body = (await res.json()) as DetailBody;
    expect(Object.keys(body.message_pagination).sort()).toEqual([
      "before_index",
      "from_index",
      "has_more_older",
      "next_before_index",
      "total",
    ]);
  });

  it("never answers 304 for anchored or after windows, only for the tail page", async () => {
    const tail = await detail("msg_limit=80");
    const etag = tail.headers.get("etag");
    expect(etag).toBeTruthy();
    const conditional = { "If-None-Match": etag as string };

    const anchored = await detail("msg_limit=120&anchor_index=150", conditional);
    expect(anchored.status).toBe(200);

    const after = await detail("msg_limit=120&after_index=210", conditional);
    expect(after.status).toBe(200);

    const tailAgain = await detail("msg_limit=80", conditional);
    expect(tailAgain.status).toBe(304);
  });
});

describe("GET /api/conversations/:id anchored paged-reader parity", () => {
  let profileDir: string;

  beforeAll(() => {
    profileDir = mkdtempSync(join(tmpdir(), "threadbase-anchored-parity-profile-"));
    writeFixture(profileDir);
  });

  async function fetchAnchoredWithScannerPrototype(
    getConversationPage: unknown,
  ): Promise<{ text: string; body: DetailBody }> {
    const port = await getRandomPort();
    const pageServer = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-anchored-parity-cache-")),
      scanProfiles: [
        { id: "parity", label: "Parity", configDir: profileDir, enabled: true, emoji: "⚓" },
      ],
      codexRoots: [],
      scannerPersistent: false,
    });
    const proto = ConversationScanner.prototype as unknown as {
      getConversationPage?: unknown;
    };
    const original = proto.getConversationPage;
    proto.getConversationPage = getConversationPage;
    try {
      await pageServer.listen(port);
      const res = await fetch(
        `http://localhost:${port}/api/conversations/${convId}?msg_limit=120&anchor_index=150`,
        { headers: { Authorization: `Bearer ${API_KEY}` } },
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      return { text, body: JSON.parse(text) };
    } finally {
      proto.getConversationPage = original;
      await pageServer.close();
    }
  }

  it("returns the same anchored window from the paged reader and the full-parse fallback", async () => {
    const proto = ConversationScanner.prototype as unknown as {
      getConversationPage?: unknown;
    };
    const paged = await fetchAnchoredWithScannerPrototype(proto.getConversationPage);
    const fallback = await fetchAnchoredWithScannerPrototype(undefined);

    expect(paged.body.message_pagination).toEqual(fallback.body.message_pagination);
    expect(paged.text).toBe(fallback.text);
  });
});
