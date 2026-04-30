import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDirectory, listDirectories, resolveBrowsePath } from "../src/browse";

const TEST_ROOT = join(tmpdir(), "threadbase-browse-test");

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "projectA", "src"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "projectA", "tests"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "projectB"), { recursive: true });
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("resolveBrowsePath", () => {
  it("resolves empty path to browseRoot", async () => {
    const resolved = await resolveBrowsePath(TEST_ROOT, "");
    expect(resolved).toBe(TEST_ROOT);
  });

  it("resolves a valid relative path", async () => {
    const resolved = await resolveBrowsePath(TEST_ROOT, "projectA");
    expect(resolved).toBe(join(TEST_ROOT, "projectA"));
  });

  it("resolves nested paths", async () => {
    const resolved = await resolveBrowsePath(TEST_ROOT, "projectA/src");
    expect(resolved).toBe(join(TEST_ROOT, "projectA", "src"));
  });

  it("strips a leading slash so the path is relative to browseRoot (bare name)", async () => {
    const resolved = await resolveBrowsePath(TEST_ROOT, "/projectA");
    expect(resolved).toBe(join(TEST_ROOT, "projectA"));
  });

  it("accepts an absolute path that is already under browseRoot (Unix)", async () => {
    if (process.platform === "win32") return;
    const resolved = await resolveBrowsePath(TEST_ROOT, join(TEST_ROOT, "projectA"));
    expect(resolved).toBe(join(TEST_ROOT, "projectA"));
  });

  it("strips a leading backslash so the path is relative to browseRoot", async () => {
    const resolved = await resolveBrowsePath(TEST_ROOT, "\\projectA");
    expect(resolved).toBe(join(TEST_ROOT, "projectA"));
  });

  it("rejects path traversal with ../", async () => {
    await expect(resolveBrowsePath(TEST_ROOT, "../")).rejects.toThrow("outside browse root");
  });

  it("rejects path traversal with nested ../", async () => {
    await expect(resolveBrowsePath(TEST_ROOT, "projectA/../../etc")).rejects.toThrow(
      "outside browse root",
    );
  });

  it("rejects nonexistent path", async () => {
    await expect(resolveBrowsePath(TEST_ROOT, "nonexistent")).rejects.toThrow();
  });
});

describe("listDirectories", () => {
  it("lists immediate subdirectories sorted alphabetically", async () => {
    const dirs = await listDirectories(TEST_ROOT);
    expect(dirs).toEqual([{ name: "projectA" }, { name: "projectB" }]);
  });

  it("lists subdirectories of a nested path", async () => {
    const dirs = await listDirectories(join(TEST_ROOT, "projectA"));
    expect(dirs).toEqual([{ name: "src" }, { name: "tests" }]);
  });

  it("returns empty array for leaf directory", async () => {
    const dirs = await listDirectories(join(TEST_ROOT, "projectB"));
    expect(dirs).toEqual([]);
  });
});

describe("createDirectory", () => {
  it("creates a new directory", async () => {
    await createDirectory(TEST_ROOT, "projectC");
    const dirs = await listDirectories(TEST_ROOT);
    expect(dirs.map((d) => d.name)).toContain("projectC");
  });

  it("rejects names containing /", async () => {
    await expect(createDirectory(TEST_ROOT, "a/b")).rejects.toThrow("Invalid directory name");
  });

  it("rejects names containing ..", async () => {
    await expect(createDirectory(TEST_ROOT, "..")).rejects.toThrow("Invalid directory name");
  });

  it("rejects if directory already exists", async () => {
    await expect(createDirectory(TEST_ROOT, "projectA")).rejects.toThrow("already exists");
  });
});
