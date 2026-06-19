import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ServerResponse } from "http";
import { handleListProjects } from "../src/handlers/handleListProjects";

// Minimal ServerResponse mock
function makeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  return {
    writeHead: vi.fn((code: number) => { statusCode = code }),
    end: vi.fn((body: string) => chunks.push(body)),
    get statusCode() { return statusCode },
    get body() { return chunks.join('') },
  } as unknown as ServerResponse & { body: string; statusCode: number };
}

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

vi.mock("os", () => ({
  homedir: () => "/home/user",
}));

import { readdirSync, statSync } from "fs";

describe("handleListProjects", () => {
  beforeEach(() => {
    vi.mocked(readdirSync).mockReturnValue([
      "-Users-user-Desktop-alpha" as unknown as import("fs").Dirent,
      "-Users-user-Desktop-beta" as unknown as import("fs").Dirent,
    ]);
    vi.mocked(statSync).mockImplementation((p) =>
      ({ mtimeMs: String(p).includes("alpha") ? 2000 : 1000 } as ReturnType<typeof statSync>),
    );
  });

  it("returns projects sorted by mtime desc", () => {
    const res = makeRes();
    handleListProjects(new URL("http://localhost/api/projects"), res as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.projects[0].dirName).toBe("-Users-user-Desktop-alpha");
    expect(body.projects[1].dirName).toBe("-Users-user-Desktop-beta");
  });

  it("decodes dirName to path", () => {
    const res = makeRes();
    handleListProjects(new URL("http://localhost/api/projects"), res as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.projects[0].path).toBe("/Users/user/Desktop/alpha");
  });

  it("sets name to last path segment", () => {
    const res = makeRes();
    handleListProjects(new URL("http://localhost/api/projects"), res as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.projects[0].name).toBe("alpha");
  });

  it("paginates with limit/offset", () => {
    const res = makeRes();
    handleListProjects(new URL("http://localhost/api/projects?limit=1&offset=1"), res as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.projects).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.projects[0].dirName).toBe("-Users-user-Desktop-beta");
  });

  it("returns empty list when projectsDir is missing", () => {
    vi.mocked(readdirSync).mockImplementation(() => { throw new Error("ENOENT") });
    const res = makeRes();
    handleListProjects(new URL("http://localhost/api/projects"), res as ServerResponse);
    const body = JSON.parse(res.body);
    expect(body.projects).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});
