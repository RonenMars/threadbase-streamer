import { closeSync, openSync, readdirSync, readSync, statSync } from "fs";
import type { ServerResponse } from "http";
import { homedir } from "os";
import { join } from "path";

// How much of a conversation JSONL to read looking for `cwd`. The field is on
// the first line in practice; a few KB of slack covers a long opening message.
const HEAD_BYTES = 64 * 1024;
// Conversations whose head we'll read before giving up on a directory. A JSONL
// truncated before its first `cwd` is rare; scanning all of them is not worth
// the file handles.
const MAX_FILES_PROBED = 3;

/**
 * The authoritative project path, read from the `cwd` a conversation in this
 * directory recorded.
 *
 * Claude encodes a project path into a directory name by replacing every '/',
 * '.' and '_' with '-', which is not invertible: `-Users-me-tb-mobile` is
 * equally `/Users/me/tb/mobile` and `/Users/me/tb-mobile`. Any path with a
 * hyphen inside a segment therefore decodes to something that exists nowhere
 * and can never be joined against a conversation's `project_path`.
 */
function readRecordedCwd(dir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }

  for (const file of files.slice(0, MAX_FILES_PROBED)) {
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, file), "r");
      const buf = Buffer.alloc(HEAD_BYTES);
      const bytes = readSync(fd, buf, 0, HEAD_BYTES, 0);
      for (const line of buf.subarray(0, bytes).toString("utf8").split("\n")) {
        if (!line.includes('"cwd"')) continue;
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
          if (typeof cwd === "string" && cwd.length > 0) return cwd;
        } catch {
          // Partial trailing line, or a line that isn't JSON — keep looking.
        }
      }
    } catch {
      // Unreadable file — try the next one.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return null;
}

function decodeProjectPath(dirName: string): string {
  // Lossy last resort, used only when no conversation in the directory records
  // a cwd (an empty or freshly-created project dir).
  return dirName.replace(/-/g, "/");
}

export function handleListProjects(url: URL, res: ServerResponse): void {
  const limit = Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const projectsDir = join(homedir(), ".claude", "projects");

  let entries: Array<{ dirName: string; mtime: number }>;
  try {
    entries = readdirSync(projectsDir)
      .map((dirName) => {
        const fullPath = join(projectsDir, dirName);
        let mtime = 0;
        try {
          mtime = statSync(fullPath).mtimeMs;
        } catch {
          // ignore stat errors — directory may have been removed
        }
        return { dirName: String(dirName), mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projects: [], total: 0 }));
    return;
  }

  const total = entries.length;
  // Resolve paths for the requested page only: reading a cwd costs a file
  // open, and there are hundreds of project directories.
  const page = entries.slice(offset, offset + limit).map(({ dirName }) => {
    const path = readRecordedCwd(join(projectsDir, dirName)) ?? decodeProjectPath(String(dirName));
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? dirName;
    return { name, path, dirName };
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ projects: page, total }));
}
