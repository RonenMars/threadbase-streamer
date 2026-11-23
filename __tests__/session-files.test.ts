import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BrowsePathNotFoundError } from "../src/browse";
import { listSessionDir, resolveSessionDir, searchSessionFiles } from "../src/session-files";

let root: string;
let cwd: string;

const touch = (rel: string) => {
  mkdirSync(join(cwd, rel, ".."), { recursive: true });
  writeFileSync(join(cwd, rel), "x");
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tb-session-files-")));
  cwd = join(root, "proj");
  mkdirSync(cwd);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveSessionDir", () => {
  it("resolves the session cwd for an empty dir", async () => {
    expect(await resolveSessionDir(root, cwd, "")).toBe(cwd);
  });

  it("resolves a nested dir relative to the cwd, not the browse root", async () => {
    mkdirSync(join(cwd, "src", "lib"), { recursive: true });
    expect(await resolveSessionDir(root, cwd, "src/lib")).toBe(join(cwd, "src", "lib"));
  });

  it("allows .. while the result stays inside the browse root", async () => {
    mkdirSync(join(root, "sibling"));
    expect(await resolveSessionDir(root, cwd, "../sibling")).toBe(join(root, "sibling"));
  });

  it("rejects a dir that escapes the browse root", async () => {
    await expect(resolveSessionDir(root, cwd, "../..")).rejects.toThrow("outside browse root");
  });

  it("rejects a session cwd outside the browse root", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "tb-elsewhere-")));
    try {
      await expect(resolveSessionDir(root, elsewhere, "")).rejects.toThrow("outside browse root");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("allows an outside cwd when browsing is unrestricted", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "tb-elsewhere-")));
    try {
      expect(await resolveSessionDir(root, elsewhere, "", true)).toBe(elsewhere);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("rejects a symlink inside the cwd that points outside the root", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "tb-elsewhere-")));
    try {
      symlinkSync(elsewhere, join(cwd, "link"));
      await expect(resolveSessionDir(root, cwd, "link")).rejects.toThrow("outside browse root");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("throws BrowsePathNotFoundError for a missing dir", async () => {
    await expect(resolveSessionDir(root, cwd, "nope")).rejects.toBeInstanceOf(
      BrowsePathNotFoundError,
    );
  });
});

describe("listSessionDir", () => {
  it("lists directories and files, sorted, without truncation", async () => {
    mkdirSync(join(cwd, "b"));
    mkdirSync(join(cwd, "a"));
    touch("z.txt");
    touch("m.txt");
    expect(await listSessionDir(cwd, 100)).toEqual({
      directories: [{ name: "a" }, { name: "b" }],
      files: [{ name: "m.txt" }, { name: "z.txt" }],
      truncated: false,
    });
  });

  it("keeps directories first and flags truncation at the limit", async () => {
    mkdirSync(join(cwd, "d1"));
    mkdirSync(join(cwd, "d2"));
    touch("f1.txt");
    touch("f2.txt");
    expect(await listSessionDir(cwd, 3)).toEqual({
      directories: [{ name: "d1" }, { name: "d2" }],
      files: [{ name: "f1.txt" }],
      truncated: true,
    });
  });

  it("is not truncated when the entry count equals the limit", async () => {
    touch("a.txt");
    touch("b.txt");
    expect((await listSessionDir(cwd, 2)).truncated).toBe(false);
  });
});

describe("searchSessionFiles", () => {
  const gitInit = () => {
    execFileSync("git", ["init", "-q"], { cwd });
  };

  it("ranks a filename prefix above a path-only match", async () => {
    touch("components/Composer.tsx");
    touch("docs/composer/notes.md");
    touch("lib/unrelated.ts");
    const out = await searchSessionFiles(cwd, "Composer", { limit: 10, budgetMs: 2000 });
    expect(out.files.map((f) => f.path)).toEqual([
      "components/Composer.tsx",
      "docs/composer/notes.md",
    ]);
  });

  it("fuzzy-matches a subsequence", async () => {
    touch("components/conversation/ChatComposer.tsx");
    const out = await searchSessionFiles(cwd, "ccomp", { limit: 10, budgetMs: 2000 });
    expect(out.files.map((f) => f.path)).toEqual(["components/conversation/ChatComposer.tsx"]);
  });

  it("returns nothing for a query that matches no path", async () => {
    touch("a.ts");
    expect((await searchSessionFiles(cwd, "zzz", { limit: 10, budgetMs: 2000 })).files).toEqual([]);
  });

  it("caps results and flags truncation", async () => {
    for (let i = 0; i < 5; i++) touch(`src/file${i}.ts`);
    const out = await searchSessionFiles(cwd, "file", { limit: 3, budgetMs: 2000 });
    expect(out.files).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("honours .gitignore inside a git repo", async () => {
    gitInit();
    writeFileSync(join(cwd, ".gitignore"), "build/\n");
    touch("build/out.js");
    touch("src/out.ts");
    const out = await searchSessionFiles(cwd, "out", { limit: 10, budgetMs: 2000 });
    expect(out.files.map((f) => f.path)).toEqual(["src/out.ts"]);
  });

  it("lists untracked files in a git repo", async () => {
    gitInit();
    touch("new-file.ts");
    const out = await searchSessionFiles(cwd, "new-file", { limit: 10, budgetMs: 2000 });
    expect(out.files.map((f) => f.path)).toEqual(["new-file.ts"]);
  });

  it("walks outside a repo and skips node_modules and hidden dirs", async () => {
    touch("node_modules/pkg/index.js");
    touch(".hidden/index.js");
    touch("src/index.js");
    const out = await searchSessionFiles(cwd, "index", { limit: 10, budgetMs: 2000 });
    expect(out.files.map((f) => f.path)).toEqual(["src/index.js"]);
  });

  it("flags truncation when the walk exceeds its entry budget", async () => {
    for (let i = 0; i < 20; i++) touch(`d${i}/f.ts`);
    const out = await searchSessionFiles(cwd, "f.ts", { limit: 50, budgetMs: 2000, maxEntries: 5 });
    expect(out.truncated).toBe(true);
  });
});
