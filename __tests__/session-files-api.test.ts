import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import type { ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { createMiscRoutes } from "../src/api/routes/misc.routes";
import { capEntries } from "../src/browse";
import { resolveFeatureFlags } from "../src/feature-flags";
import { requiredCapability } from "../src/services/security/capabilities";
import type { SessionStore } from "../src/session-store";

function fakeRes() {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    writeHead: (s: number) => {
      out.status = s;
    },
    end: (b: string) => {
      out.body = JSON.parse(b);
    },
  } as unknown as ServerResponse;
  return { res, out };
}

let root: string;
let cwd: string;

function handlers(
  over: { projectPath?: string | null; browseRoot?: string | null; unrestricted?: boolean } = {},
) {
  const projectPath = over.projectPath === undefined ? cwd : over.projectPath;
  return new SessionHandlers({
    sessionStore: { get: (id: string) => (id === "s1" ? { id, projectPath } : null) },
    ptyAttachedIds: () => new Set(),
    browseRoot: () => (over.browseRoot === undefined ? root : over.browseRoot),
    browseUnrestricted: () => over.unrestricted ?? false,
  } as unknown as SessionHandlersDeps);
}

async function list(h: SessionHandlers, id: string, query = "") {
  const { res, out } = fakeRes();
  await h.handleListSessionFiles(id, new URL(`http://x/api/sessions/${id}/files${query}`), res);
  return out;
}

async function search(h: SessionHandlers, id: string, query: string) {
  const { res, out } = fakeRes();
  await h.handleSearchSessionFiles(
    id,
    new URL(`http://x/api/sessions/${id}/files/search${query}`),
    res,
  );
  return out;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tb-session-files-api-")));
  cwd = join(root, "proj");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), "x");
  writeFileSync(join(cwd, "src", "app.ts"), "x");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("GET /api/sessions/:id/files", () => {
  it("lists the session cwd for an empty dir", async () => {
    expect(await list(handlers(), "s1")).toEqual({
      status: 200,
      body: {
        path: "",
        directories: [{ name: "src" }],
        files: [{ name: "README.md" }],
        truncated: false,
      },
    });
  });

  it("lists a subdirectory relative to the cwd", async () => {
    const out = await list(handlers(), "s1", "?dir=src");
    expect(out.status).toBe(200);
    expect(out.body?.files).toEqual([{ name: "app.ts" }]);
    expect(out.body?.path).toBe("src");
  });

  it("honours limit and flags truncation", async () => {
    const out = await list(handlers(), "s1", "?limit=1");
    expect(out.body).toMatchObject({ directories: [{ name: "src" }], files: [], truncated: true });
  });

  it.each(["0", "-1", "abc", "1.5", "1001"])("rejects limit=%s with 400", async (bad) => {
    expect((await list(handlers(), "s1", `?limit=${bad}`)).status).toBe(400);
  });

  it("answers 404 for an unknown session", async () => {
    expect((await list(handlers(), "nope")).status).toBe(404);
  });

  it("answers 404 PATH_NOT_FOUND for a missing dir", async () => {
    const out = await list(handlers(), "s1", "?dir=missing");
    expect(out).toMatchObject({ status: 404, body: { code: "PATH_NOT_FOUND" } });
  });

  it("answers 400 for a dir that escapes the browse root", async () => {
    expect((await list(handlers(), "s1", "?dir=../..")).status).toBe(400);
  });

  it("answers 403 when no browse root is configured", async () => {
    const out = await list(handlers({ browseRoot: null }), "s1");
    expect(out).toMatchObject({ status: 403, body: { code: "BROWSE_ROOT_NOT_SET" } });
  });

  it("answers 404 when the session has no working directory", async () => {
    const out = await list(handlers({ projectPath: null }), "s1");
    expect(out).toMatchObject({ status: 404, body: { code: "NO_SESSION_CWD" } });
  });
});

describe("GET /api/sessions/:id/files/search", () => {
  it("returns ranked relative paths", async () => {
    const out = await search(handlers(), "s1", "?q=app");
    expect(out).toEqual({
      status: 200,
      body: { files: [{ path: "src/app.ts" }], truncated: false },
    });
  });

  it("honours limit", async () => {
    writeFileSync(join(cwd, "src", "app2.ts"), "x");
    const out = await search(handlers(), "s1", "?q=app&limit=1");
    expect(out.body).toMatchObject({ truncated: true });
    expect(out.body).toMatchObject({ files: [expect.anything()] });
  });

  it.each(["", "?q=", `?q=${"a".repeat(201)}`, "?q=a&limit=0", "?q=a&limit=201", "?q=a&limit=x"])(
    "rejects %j with 400",
    async (bad) => {
      expect((await search(handlers(), "s1", bad)).status).toBe(400);
    },
  );

  it("answers 404 for an unknown session", async () => {
    expect((await search(handlers(), "nope", "?q=a")).status).toBe(404);
  });

  it("answers 403 when no browse root is configured", async () => {
    expect((await search(handlers({ browseRoot: null }), "s1", "?q=a")).status).toBe(403);
  });

  it("answers 400 when the session cwd is outside the browse root", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "tb-elsewhere-")));
    try {
      expect((await search(handlers({ projectPath: elsewhere }), "s1", "?q=a")).status).toBe(400);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("capEntries", () => {
  const d = [{ name: "a" }, { name: "b" }];
  const f = [{ name: "c" }, { name: "d" }];

  it("passes everything through under the limit", () => {
    expect(capEntries(d, f, 4)).toEqual({ directories: d, files: f, truncated: false });
  });

  it("keeps directories first when cutting", () => {
    expect(capEntries(d, f, 3)).toEqual({
      directories: d,
      files: [{ name: "c" }],
      truncated: true,
    });
    expect(capEntries(d, f, 1)).toEqual({
      directories: [{ name: "a" }],
      files: [],
      truncated: true,
    });
  });
});

describe("session file routes capability", () => {
  it.each(["/api/sessions/abc/files", "/api/sessions/abc/files/search"])(
    "treats GET %s as fs:browse",
    (path) => {
      expect(requiredCapability(path, "GET")).toBe("fs:browse");
    },
  );

  it("leaves the upload POST on session control", () => {
    expect(requiredCapability("/api/sessions/abc/files", "POST")).toBe("session:control");
  });

  it("leaves other session reads on history:read", () => {
    expect(requiredCapability("/api/sessions/abc/output", "GET")).toBe("history:read");
  });
});

describe("GET /api/info sessionFiles", () => {
  it("advertises session-relative listing and search", async () => {
    const flags = resolveFeatureFlags({ env: {} });
    const app = createMiscRoutes({
      publicUrl: null,
      sessionStore: { list: () => [] } as unknown as SessionStore,
      ptyAttachedIds: () => new Set(),
      rotateApiKey: () => ({ newKey: "x", persisted: false }),
      localNoAuth: true,
      pushRepo: () => null,
      liveActivityPushEnabled: () => false,
      expoPushEnabled: () => false,
      featureFlagsConfig: () => ({ registry: [], values: flags.values, sources: flags.sources }),
    });
    const body = (await (await app.request("/api/info")).json()) as { sessionFiles: boolean };
    expect(body.sessionFiles).toBe(true);
  });
});
