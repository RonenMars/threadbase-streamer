import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_test_key_for_search_query_method";

describe("QUERY /api/search (GET retained)", () => {
  let server: StreamerServer;
  let port: number;

  beforeAll(async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "threadbase-search-query-profile-"));
    const projDir = join(profileDir, "projects", "-tmp-searchquery-project");
    mkdirSync(projDir, { recursive: true });
    for (const n of [1, 2, 3]) {
      const sessionId = `search-query-session-${n}`;
      const line = JSON.stringify({
        type: "user",
        uuid: `sq-${n}`,
        timestamp: `2026-06-05T08:00:0${n}.000Z`,
        sessionId,
        slug: "sq-session",
        cwd: "/tmp/searchquery-project",
        message: { role: "user", content: [{ type: "text", text: `a quokka appears ${n}` }] },
      });
      writeFileSync(join(projDir, `${sessionId}.jsonl`), `${line}\n`);
    }

    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-search-query-cache-")),
      scanProfiles: [
        { id: "sq", label: "SearchQuery", configDir: profileDir, enabled: true, emoji: "🔎" },
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

  const auth = { Authorization: `Bearer ${API_KEY}` };
  const url = () => `http://localhost:${port}/api/search`;
  // tookMs is per-request timing, so it can never match across two calls.
  const stable = async (res: Response) => {
    const { tookMs: _tookMs, ...rest } = (await res.json()) as Record<string, unknown>;
    return rest;
  };
  const query = (body: unknown) =>
    fetch(url(), {
      method: "QUERY",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("GET still answers with a result list", async () => {
    const res = await fetch(`${url()}?q=quokka&limit=2`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations.length).toBe(2);
  });

  it("GET without q is still 400 invalid_query", async () => {
    const res = await fetch(url(), { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_query");
  });

  it("QUERY returns the same body as GET for the same q and limit", async () => {
    const get = await stable(await fetch(`${url()}?q=quokka&limit=2`, { headers: auth }));
    const res = await query({ q: "quokka", limit: 2 });
    expect(res.status).toBe(200);
    expect(await stable(res)).toEqual(get);
  });

  it("QUERY without limit uses the default, like GET", async () => {
    const get = await stable(await fetch(`${url()}?q=quokka`, { headers: auth }));
    const res = await query({ q: "quokka" });
    expect(res.status).toBe(200);
    expect(await stable(res)).toEqual(get);
  });

  it("advertises the supported query media type via Accept-Query", async () => {
    const res = await query({ q: "quokka" });
    expect(res.headers.get("accept-query")).toBe("application/json");
  });

  it("returns 415 for an unsupported Content-Type", async () => {
    const res = await fetch(url(), {
      method: "QUERY",
      headers: { ...auth, "Content-Type": "text/plain" },
      body: "q=quokka",
    });
    expect(res.status).toBe(415);
    expect(res.headers.get("accept-query")).toBe("application/json");
    expect(((await res.json()) as { code: string }).code).toBe("unsupported_media_type");
  });

  it("returns 422 invalid_query for a missing, blank, non-string or overlong q", async () => {
    for (const body of [{}, { q: "" }, { q: "   " }, { q: 5 }, { q: "x".repeat(300) }]) {
      const res = await query(body);
      expect(res.status).toBe(422);
      expect(res.headers.get("accept-query")).toBe("application/json");
      expect(((await res.json()) as { code: string }).code).toBe("invalid_query");
    }
  });

  it("returns 422 invalid_query for a bad limit", async () => {
    for (const limit of ["ten", 1.5, null, {}]) {
      const res = await query({ q: "quokka", limit });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_query");
    }
  });

  it("returns 422 for a malformed JSON body", async () => {
    const res = await fetch(url(), {
      method: "QUERY",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_query");
  });

  it("requires auth like GET", async () => {
    const res = await fetch(url(), {
      method: "QUERY",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "quokka" }),
    });
    expect(res.status).toBe(401);
  });
});
