import { execFile } from "child_process";
import type { Dirent } from "fs";
import { lstat, readdir, realpath } from "fs/promises";
import { basename, join, resolve } from "path";
import {
  BrowsePathNotFoundError,
  capEntries,
  isSameOrInside,
  listDirectories,
  listFiles,
} from "./browse";

export class OutsideBrowseRootError extends Error {
  constructor() {
    super("Path outside browse root");
    this.name = "OutsideBrowseRootError";
  }
}

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
  const target = resolve(cwd, dir);
  const root = unrestricted ? null : await realpath(resolve(browseRoot));
  let real: string;
  try {
    real = await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    // Containment first: a missing path outside the root must answer exactly
    // like an existing one, or the 404 maps the filesystem beyond browseRoot.
    if (root && !isSameOrInside(target, root) && !isSameOrInside(target, resolve(browseRoot))) {
      throw new OutsideBrowseRootError();
    }
    throw new BrowsePathNotFoundError(`Path not found: ${dir}`);
  }
  if (root && !isSameOrInside(real, root)) throw new OutsideBrowseRootError();
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
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
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
    // Git gets two thirds so a timeout still leaves the walk a real slice of the budget.
    paths = await execGit(cwd, Math.ceil((opts.budgetMs * 2) / 3));
    if (paths.length > maxEntries) {
      paths = paths.slice(0, maxEntries);
      truncated = true;
    }
  } catch {
    ({ paths, truncated } = await walk(cwd, maxEntries, deadline));
  }
  const q = query.toLowerCase();
  const ranked = [...new Set(paths)]
    .filter((path) => !path.endsWith("/"))
    .map((path) => ({ path, t: tier(path, q) }))
    .filter((m) => m.t >= 0)
    .sort((a, b) => a.t - b.t || a.path.length - b.path.length || a.path.localeCompare(b.path));
  // Git lists tracked files that were since deleted, so keep only paths that still exist.
  const files: { path: string }[] = [];
  for (const { path } of ranked) {
    if (files.length > opts.limit) break;
    if (
      await lstat(join(cwd, path)).then(
        () => true,
        () => false,
      )
    )
      files.push({ path });
  }
  return {
    files: files.slice(0, opts.limit),
    truncated: truncated || files.length > opts.limit,
  };
}
