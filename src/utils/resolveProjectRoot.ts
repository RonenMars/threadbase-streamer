import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeProjectPath } from "./canonicalizeProjectPath";

export interface ProjectRoot {
  /** The main checkout: where `.git` is a directory. Equals the cwd when it is not a linked worktree. */
  projectRoot: string;
  /** The cwd itself when it is a linked worktree of `projectRoot`; null otherwise. */
  worktreePath: string | null;
}

// A linked worktree's `.git` file reads `gitdir: <root>/.git/worktrees/<name>`.
// A submodule's reads `gitdir: <root>/.git/modules/<name>` and is its own project.
const WORKTREE_GITDIR = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/;

const resolved = new Map<string, ProjectRoot>();

/**
 * Resolve which project a working directory belongs to, so two worktrees of
 * one repo can be grouped. Reads one small file, no `git` subprocess.
 *
 * Returns null when nothing can be said (path gone, no `.git`): callers keep
 * the raw path and retry later, because a deleted worktree cannot be resolved
 * but an unmounted drive can come back. Only positive answers are memoized.
 */
export function resolveProjectRoot(cwd: string): ProjectRoot | null {
  const path = canonicalizeProjectPath(cwd);
  if (!path) return null;
  const hit = resolved.get(path);
  if (hit) return hit;

  let text: string;
  try {
    text = readFileSync(join(path, ".git"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EISDIR") return null;
    return remember(path, { projectRoot: path, worktreePath: null });
  }

  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  const root = gitdir ? WORKTREE_GITDIR.exec(resolve(path, gitdir))?.[1] : undefined;
  return remember(
    path,
    root ? { projectRoot: root, worktreePath: path } : { projectRoot: path, worktreePath: null },
  );
}

function remember(path: string, value: ProjectRoot): ProjectRoot {
  resolved.set(path, value);
  return value;
}
