import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_test_key_for_browse_limit";

describe("GET /api/browse limit", () => {
  let server: StreamerServer;
  let root: string;
  let cacheDir: string;

  beforeAll(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "tb-browse-limit-")));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-browse-limit-cache-"));
    mkdirSync(join(root, "d1"));
    mkdirSync(join(root, "d2"));
    writeFileSync(join(root, "f1.txt"), "x");
    writeFileSync(join(root, "f2.txt"), "x");
    server = new StreamerServer({
      codexRoots: [],
      cursorRoots: [],
      scannerPersistent: false,
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      browseRoot: root,
      scanProfiles: [],
    });
    await server.listen(0, { awaitReady: true });
  });

  afterAll(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const browse = (query: string) =>
    fetch(`http://127.0.0.1:${server.port}/api/browse?path=${query}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

  it("keeps the old shape when limit is absent", async () => {
    const body = await (await browse("")).json();
    expect(body).toEqual({
      path: "",
      directories: [{ name: "d1" }, { name: "d2" }],
      files: [{ name: "f1.txt" }, { name: "f2.txt" }],
    });
  });

  it("caps the listing and flags truncation when limit is set", async () => {
    const body = await (await browse("&limit=3")).json();
    expect(body).toEqual({
      path: "",
      directories: [{ name: "d1" }, { name: "d2" }],
      files: [{ name: "f1.txt" }],
      truncated: true,
    });
  });

  it("reports truncated false when everything fits", async () => {
    const body = (await (await browse("&limit=4")).json()) as { truncated: boolean };
    expect(body.truncated).toBe(false);
  });

  it.each(["0", "-1", "abc", "1001"])("rejects limit=%s with 400", async (bad) => {
    expect((await browse(`&limit=${bad}`)).status).toBe(400);
  });
});
