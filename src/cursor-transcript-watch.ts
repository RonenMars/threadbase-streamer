import { existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Cursor stores projects as `~/.cursor/projects/<slug>` where `slug` is the
 * absolute project path with separators (and a Windows drive colon) replaced by
 * `-`, and a leading POSIX `/` dropped:
 * `/Users/me/app` → `Users-me-app`, `C:\Users\me\app` → `C-Users-me-app`.
 * Matches what `@threadbase-sh/scanner`'s `decodeCursorProjectSlug` reverses.
 */
export function cursorProjectSlug(projectPath: string): string {
  // Drop the drive colon before turning separators into `-`, otherwise
  // `C:\Users\me` becomes `C--Users-me` (`:` → `-`, then `/` → `-`).
  return projectPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/:/g, "").replace(/\//g, "-");
}

/**
 * Cursor `cursorRoots` default to `~/.cursor/projects`. Watching that root
 * recursively also sees canvases and `node_modules` and will EMFILE a machine
 * with many Cursor worktrees. Only the `agent-transcripts` folders matter.
 */
export function listCursorTranscriptWatchDirs(roots: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    for (const slug of readdirSync(dir, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const transcripts = join(dir, slug.name, "agent-transcripts");
      if (existsSync(transcripts)) dirs.push(transcripts);
    }
  }
  return dirs;
}

/** `cursorRoots/<slug>/agent-transcripts` for a live session's project path. */
export function cursorAgentTranscriptsDir(cursorRoot: string, projectPath: string): string {
  return join(cursorRoot, cursorProjectSlug(projectPath), "agent-transcripts");
}
