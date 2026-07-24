import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";
import {
  findSearchTarget,
  type SearchableMessage,
} from "../src/services/conversations/findSearchTarget";

const API_KEY = "tb_test_key_for_search_target_tests";

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

describe("findSearchTarget", () => {
  const text = (t: string, uuid?: string): SearchableMessage => ({ text: t, uuid });

  it("returns the matching message's index and uuid", () => {
    const messages = [text("hello there"), text("the wombat hides here", "u-1"), text("goodbye")];
    const target = findSearchTarget(messages, "wombat");
    expect(target).toEqual({
      messageIndex: 1,
      uuid: "u-1",
      snippet: "the wombat hides here",
      matchIndexes: [1],
      totalMatches: 1,
    });
  });

  it("matches case-insensitively", () => {
    const messages = [text("The WOMBAT Hides")];
    expect(findSearchTarget(messages, "wombat")?.messageIndex).toBe(0);
    expect(findSearchTarget(messages, "WoMbAt")?.messageIndex).toBe(0);
  });

  it("returns the last chronological match when the query appears in several messages", () => {
    const messages: SearchableMessage[] = [];
    for (let i = 0; i < 250; i++) messages.push(text(`filler line ${i}`));
    messages[5] = text("early wombat", "u-5");
    messages[200] = text("late wombat", "u-200");
    const target = findSearchTarget(messages, "wombat");
    expect(target?.messageIndex).toBe(200);
    expect(target?.uuid).toBe("u-200");
    expect(target?.matchIndexes).toEqual([5, 200]);
    expect(target?.totalMatches).toBe(2);
  });

  it("prefers a text match over a later tool-content match", () => {
    const messages: SearchableMessage[] = [
      text("a wombat in plain text", "u-0"),
      {
        text: "no match here",
        metadata: { toolResults: [{ content: "tool wombat result" }] },
      },
    ];
    const target = findSearchTarget(messages, "wombat");
    expect(target?.messageIndex).toBe(0);
    expect(target?.matchIndexes).toEqual([0]);
    expect(target?.totalMatches).toBe(1);
  });

  it("caps match_indexes at the last 1000 while counting all matches", () => {
    const messages: SearchableMessage[] = [];
    for (let i = 0; i < 1100; i++) messages.push(text(`wombat ${i}`));
    const target = findSearchTarget(messages, "wombat");
    expect(target?.totalMatches).toBe(1100);
    expect(target?.matchIndexes.length).toBe(1000);
    expect(target?.matchIndexes[0]).toBe(100);
    expect(target?.matchIndexes[999]).toBe(1099);
    expect(target?.messageIndex).toBe(1099);
  });

  it("falls back to tool_use input and tool_result content", () => {
    const messages: SearchableMessage[] = [
      text("nothing here"),
      { text: "", metadata: { toolUseBlocks: [{ input: { path: "/tmp/wombat.txt" } }] } },
      { text: "", metadata: { toolResults: [{ content: "found a capybara" }] } },
    ];
    expect(findSearchTarget(messages, "wombat")?.messageIndex).toBe(1);
    expect(findSearchTarget(messages, "capybara")?.messageIndex).toBe(2);
  });

  it("falls back to thinking content", () => {
    const messages: SearchableMessage[] = [
      text("nothing here"),
      { text: "", isThinking: true, thinkingContent: "pondering the wombat problem" },
    ];
    expect(findSearchTarget(messages, "wombat")?.messageIndex).toBe(1);
  });

  it("returns null when nothing matches", () => {
    const messages = [text("hello"), { text: "", metadata: { toolResults: [{ content: "x" }] } }];
    expect(findSearchTarget(messages, "wombat")).toBeNull();
  });

  it("builds a truncated snippet with collapsed whitespace", () => {
    const long = `${"a".repeat(100)} before\n\n  the wombat sighting \t after ${"z".repeat(100)}`;
    const target = findSearchTarget([text(long)], "wombat");
    expect(target?.snippet).toContain("wombat");
    expect(target?.snippet.startsWith("…")).toBe(true);
    expect(target?.snippet.endsWith("…")).toBe(true);
    expect(target?.snippet).not.toMatch(/\s{2,}/);
    expect(target?.snippet).not.toContain("\n");
  });
});

describe("QUERY /api/conversations/:id/search-target", () => {
  let server: StreamerServer;
  let port: number;
  const convId = "search-target-session-4444";

  beforeAll(async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "threadbase-search-target-profile-"));
    const projDir = join(profileDir, "projects", "-tmp-searchtarget-project");
    mkdirSync(projDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      let body = `plain filler line ${i}`;
      if (i === 42) body = "an early wombat appears";
      if (i === 150) body = "a later wombat appears";
      lines.push(
        `${JSON.stringify({
          type: role,
          uuid: `st-${i}`,
          timestamp: `2026-06-05T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(
            i % 60,
          ).padStart(2, "0")}.000Z`,
          sessionId: convId,
          slug: "st-session",
          cwd: "/tmp/searchtarget-project",
          message: { role, model: "claude-sonnet-4-6", content: [{ type: "text", text: body }] },
        })}\n`,
      );
    }
    writeFileSync(join(projDir, `${convId}.jsonl`), lines.join(""));

    port = await getRandomPort();
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-search-target-cache-")),
      scanProfiles: [
        { id: "st", label: "SearchTarget", configDir: profileDir, enabled: true, emoji: "🔎" },
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
  const target = (id: string, q: string) =>
    fetch(`http://localhost:${port}/api/conversations/${id}/search-target`, {
      method: "QUERY",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
    });

  it("resolves a body match to the last matching message_index", async () => {
    const res = await target(convId, "wombat");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      query: "wombat",
      message_index: 150,
      uuid: "st-150",
      snippet: "a later wombat appears",
      match_indexes: [42, 150],
      total_matches: 2,
    });
  });

  it("does not fall through to the conversation detail route", async () => {
    const res = await target(convId, "wombat");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("message_index");
    expect(body).not.toHaveProperty("meta");
    expect(body).not.toHaveProperty("messages");
  });

  it("returns 404 search_target_not_found for a metadata-only match", async () => {
    // "searchtarget" appears in cwd/slug but in no message body.
    const res = await target(convId, "searchtarget");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("search_target_not_found");
  });

  it("returns 404 not_found for an unknown conversation", async () => {
    const res = await target("no-such-conversation", "wombat");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("not_found");
  });

  it("returns 422 invalid_query for a missing, blank, or overlong q", async () => {
    for (const q of ["", "   ", "x".repeat(300)]) {
      const res = await target(convId, q);
      expect(res.status).toBe(422);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("invalid_query");
    }
  });

  it("advertises the supported query media type via Accept-Query", async () => {
    const res = await target(convId, "wombat");
    expect(res.headers.get("accept-query")).toBe("application/json");
  });

  it("returns 415 for an unsupported Content-Type", async () => {
    const res = await fetch(`http://localhost:${port}/api/conversations/${convId}/search-target`, {
      method: "QUERY",
      headers: { ...auth, "Content-Type": "text/plain" },
      body: "q=wombat",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("unsupported_media_type");
  });

  it("returns 422 for a malformed JSON body", async () => {
    const res = await fetch(`http://localhost:${port}/api/conversations/${convId}/search-target`, {
      method: "QUERY",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("invalid_query");
  });

  it("does not respond to the old GET ?q= form (method no longer accepted)", async () => {
    const res = await fetch(
      `http://localhost:${port}/api/conversations/${convId}/search-target?q=wombat`,
      { headers: auth },
    );
    // No QUERY route is registered for GET, so this now falls through to the
    // greedy "/:id{.+}" conversation-detail route, which treats the whole
    // "<convId>/search-target" segment as the id — an id that doesn't exist —
    // and 404s as not_found. Proves the endpoint is QUERY-only: the old GET
    // ?q= form is no longer silently answered by the resolver.
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("not_found");
    expect(body).not.toHaveProperty("message_index");
  });
});
