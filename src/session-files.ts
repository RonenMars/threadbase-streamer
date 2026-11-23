import { execFile } from "child_process";
import { readdir, realpath } from "fs/promises";
import { basename, join, resolve, sep } from "path";
import { BrowsePathNotFoundError, capEntries, listDirectories, listFiles } from "./browse";

/**
 * Resolves `dir` relative to the SESSION cwd (not browseRoot) and returns the
 * real path. Unlike resolveBrowsePath, containment is checked on the realpath,
 * so a symlink inside the cwd cannot lead out of browseRoot.
 */
export async function resolveSessionDir(
  browseRoot: string,
  cwd: string,
  dir: string,
  unrestricted = false,
): Promise<string> {
  let real: string;
  try {
    real = await realpath(resolve(cwd, dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new BrowsePathNotFoundError(`Path not found: ${dir}`);
    }
    throw err;
  }
  if (!unrestricted) {
    const root = await realpath(resolve(browseRoot));
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (real !== root && !real.startsWith(prefix)) throw new Error("Path outside browse root");
  }
  return real;
}

export async function listSessionDir(abs: string, limit: number) {
  const [directories, files] = await Promise.all([listDirectories(abs), listFiles(abs)]);
  return capEntries(directories, files, limit);
}

/** A decimal integer in 1..max, `fallback` when absent, null when malformed. */
export function parseLimit(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

export interface SearchOptions {
  limit: number;
  budgetMs: number;
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;

function execGit(cwd: string, budgetMs: number): Promise<string[]> {
  return new Promise((ok, fail) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, timeout: budgetMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? fail(err) : ok(stdout.split("\0").filter(Boolean))),
    );
  });
}

// ponytail: the non-git walk skips every dot-directory and node_modules, with no
// .gitignore support; teach it ignore files if non-repo cwds turn out to matter.
async function walk(root: string, maxEntries: number, deadline: number) {
  const paths: string[] = [];
  let seen = 0;
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop() as string;
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      if (++seen > maxEntries || Date.now() > deadline) return { paths, truncated: true };
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith("."))
          stack.push(rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        paths.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  }
  return { paths, truncated: false };
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
}

/** 0 = filename prefix, 1 = in filename, 2 = in path, 3 = scattered subsequence, -1 = no match. */
function tier(path: string, q: string): number {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (lower.includes(q)) return 2;
  return isSubsequence(q, lower) ? 3 : -1;
}

export async function searchSessionFiles(cwd: string, query: string, opts: SearchOptions) {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const deadline = Date.now() + opts.budgetMs;
  let paths: string[];
  let truncated = false;
  try {
    paths = await execGit(cwd, opts.budgetMs);
    if (paths.length > maxEntries) {
      paths = paths.slice(0, maxEntries);
      truncated = true;
    }
  } catch {
    ({ paths, truncated } = await walk(cwd, maxEntries, deadline));
  }
  const q = query.toLowerCase();
  const ranked = paths
    .map((path) => ({ path, t: tier(path, q) }))
    .filter((m) => m.t >= 0)
    .sort((a, b) => a.t - b.t || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return {
    files: ranked.slice(0, opts.limit).map(({ path }) => ({ path })),
    truncated: truncated || ranked.length > opts.limit,
  };
}
