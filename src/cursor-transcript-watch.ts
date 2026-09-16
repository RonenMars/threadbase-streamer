import { existsSync, readdirSync } from "fs";
import { join } from "path";

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
