import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_RECORD_BYTES } from "../src/e2ee/record";
import { StreamerServer } from "../src/server";

/**
 * Every route that reads a request body must answer an oversized one with 413.
 *
 * `readBody` (http-helpers) and `readJsonBody` (misc.routes) both throw a
 * BodyTooLargeError once the body passes their bound. A handler that does not
 * catch it lets it reach `errorMiddleware`, which used to turn it into a bare
 * 500 — a client cannot tell "your upload is too big" from "the server broke".
 * The routes below are the ones that read the body without catching that error
 * themselves; the controls at the end are the ones that already did.
 */

const API_KEY = "tb_test_key_for_body_too_large";
const HEADERS = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const HOST_ISOLATION = {
  codexRoots: [] as string[],
  cursorRoots: [] as string[],
  scannerPersistent: false,
};

// Past the bound of readBody's default (4 MiB) and readJsonBody's (1 MiB).
const OVERSIZED = JSON.stringify({ x: "A".repeat(MAX_RECORD_BYTES + 1024) });

type Row = { method: string; path: string };

// Handlers with no catch of their own around the body read.
const UNCAUGHT: Row[] = [
  { method: "POST", path: "/api/sessions/resume" },
  { method: "POST", path: "/api/sessions/start" },
  { method: "POST", path: "/api/sessions/s1/fork" },
  { method: "POST", path: "/api/sessions/s1/input" },
  { method: "POST", path: "/api/sessions/s1/raw-key" },
  { method: "POST", path: "/api/sessions/s1/answer" },
  { method: "POST", path: "/api/sessions/s1/prompt/answer" },
  { method: "POST", path: "/api/sessions/s1/permission/answer" },
  { method: "POST", path: "/api/browse/mkdir" },
];

// Handlers that swallow every read error as a generic 4xx.
const SWALLOWED: Row[] = [
  { method: "PATCH", path: "/api/sessions/s1/name" },
  { method: "POST", path: "/api/backup/restore" },
  { method: "QUERY", path: "/api/conversations/c1/search-target" },
  { method: "POST", path: "/api/push/register" },
  { method: "DELETE", path: "/api/push/register" },
  { method: "PATCH", path: "/api/push/preferences" },
  { method: "POST", path: "/api/push/test" },
];

// Handlers that already answered 413 before this change.
const CONTROLS: Row[] = [
  { method: "POST", path: "/api/__client-log" },
  { method: "PUT", path: "/api/saved-items/order" },
  { method: "PUT", path: "/api/saved-items/k1" },
];

describe("an oversized request body answers 413", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let cacheDir: string;
  let browseRoot: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "threadbase-413-cache-"));
    browseRoot = mkdtempSync(join(tmpdir(), "threadbase-413-browse-"));
    server = new StreamerServer({
      ...HOST_ISOLATION,
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      cacheDir,
      browseRoot,
      scanProfiles: [],
    });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(browseRoot, { recursive: true, force: true });
  });

  const send = (row: Row, body: string) =>
    fetch(`${baseUrl}${row.path}`, { method: row.method, headers: HEADERS, body });

  // Positive control: the same routes do not answer 413 for a small body, so a
  // 413 below is the size and not the route refusing everything.
  it.each([...UNCAUGHT, ...SWALLOWED, ...CONTROLS])(
    "$method $path does not answer 413 for a small body",
    async (row) => {
      const res = await send(row, "{}");
      expect(res.status).not.toBe(413);
    },
  );

  it.each(UNCAUGHT)("$method $path answers 413 with PAYLOAD_TOO_LARGE", async (row) => {
    const res = await send(row, OVERSIZED);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: expect.stringMatching(/too large/i),
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it.each(SWALLOWED)("$method $path answers 413 rather than a generic 4xx", async (row) => {
    const res = await send(row, OVERSIZED);
    expect(res.status).toBe(413);
  });

  it.each(CONTROLS)("$method $path still answers 413", async (row) => {
    const res = await send(row, OVERSIZED);
    expect(res.status).toBe(413);
  });
});
