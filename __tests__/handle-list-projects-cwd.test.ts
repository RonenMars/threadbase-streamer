import { mkdirSync, rmSync, writeFileSync } from "fs";
import type { ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleListProjects } from "../src/handlers/handleListProjects";

// Real filesystem, faked home — the whole point of these cases is what the
// handler reads off disk, so nothing about fs is mocked here.
let home: string;
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => process.env.TEST_FAKE_HOME as string };
});

function makeRes() {
  const chunks: string[] = [];
  return {
    writeHead: vi.fn(),
    end: vi.fn((body: string) => chunks.push(body)),
    get body() {
      return chunks.join("");
    },
  } as unknown as ServerResponse & { body: string };
}

function makeProjectDir(dirName: string, cwd: string | null, extraHead = ""): void {
  const dir = join(home, ".claude", "projects", dirName);
  mkdirSync(dir, { recursive: true });
  if (cwd === null) return;
  writeFileSync(
    join(dir, "conv-1.jsonl"),
    `${extraHead}${JSON.stringify({ type: "user", cwd, sessionId: "conv-1" })}\n`,
  );
}

function listProjects(query = ""): Array<{ name: string; path: string; dirName: string }> {
  const res = makeRes();
  handleListProjects(new URL(`http://localhost/api/projects${query}`), res as ServerResponse);
  return JSON.parse(res.body).projects;
}

beforeEach(() => {
  home = join(tmpdir(), `list-projects-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.TEST_FAKE_HOME = home;
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TEST_FAKE_HOME;
});

describe("handleListProjects path resolution", () => {
  it("recovers a path with a hyphen inside a segment", () => {
    // The dirName alone is ambiguous: '/Users/me/tb-mobile' and
    // '/Users/me/tb/mobile' encode identically. Decoding it produces a path
    // that exists nowhere and never matches a conversation's project_path.
    makeProjectDir("-Users-me-dev-tb-mobile", "/Users/me/dev/tb-mobile");
    expect(listProjects()[0]).toMatchObject({
      path: "/Users/me/dev/tb-mobile",
      name: "tb-mobile",
    });
  });

  it("recovers a path containing a dot, which the dirName also flattens", () => {
    makeProjectDir("-Users-me-dev--config-app", "/Users/me/dev/.config/app");
    expect(listProjects()[0].path).toBe("/Users/me/dev/.config/app");
  });

  it("finds the cwd when it is not on the first line", () => {
    makeProjectDir(
      "-Users-me-dev-tb-mobile",
      "/Users/me/dev/tb-mobile",
      `${JSON.stringify({ type: "summary", summary: "no cwd here" })}\n`,
    );
    expect(listProjects()[0].path).toBe("/Users/me/dev/tb-mobile");
  });

  it("falls back to the lossy decode when no conversation records a cwd", () => {
    makeProjectDir("-Users-me-dev-alpha", null);
    expect(listProjects()[0].path).toBe("/Users/me/dev/alpha");
  });

  it("only resolves the requested page", () => {
    makeProjectDir("-Users-me-dev-tb-mobile", "/Users/me/dev/tb-mobile");
    makeProjectDir("-Users-me-dev-tb-streamer", "/Users/me/dev/tb-streamer");
    const page = listProjects("?limit=1");
    expect(page).toHaveLength(1);
    expect(page[0].path.startsWith("/Users/me/dev/")).toBe(true);
  });
});
