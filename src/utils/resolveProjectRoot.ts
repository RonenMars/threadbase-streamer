import { type ProjectRoot, readProjectRoot } from "@threadbase-sh/scanner";
import { canonicalizeProjectPath } from "./canonicalizeProjectPath";

export type { ProjectRoot };

const resolved = new Map<string, ProjectRoot>();

/**
 * Which project a working directory belongs to, so two worktrees of one repo
 * can be grouped. The rule lives in the scanner (`readProjectRoot`); this adds
 * canonicalisation and a memo, since the cache calls it for every upsert.
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
  const r = readProjectRoot(path);
  if (r) resolved.set(path, r);
  return r;
}
