import { readdirSync, statSync } from "fs";
import type { ServerResponse } from "http";
import { homedir } from "os";
import { join } from "path";

function decodeProjectPath(dirName: string): string {
  // Claude encodes project paths by replacing '/' with '-', starting from root.
  // e.g. '-Users-foo-Desktop-dev-myproject' → '/Users/foo/Desktop/dev/myproject'
  return dirName.replace(/-/g, "/");
}

export function handleListProjects(url: URL, res: ServerResponse): void {
  const limit = Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const projectsDir = join(homedir(), ".claude", "projects");

  let entries: Array<{ name: string; path: string; dirName: string; mtime: number }>;
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
        const path = decodeProjectPath(dirName);
        const name = path.split("/").filter(Boolean).pop() ?? dirName;
        return { name, path, dirName, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projects: [], total: 0 }));
    return;
  }

  const total = entries.length;
  const page = entries
    .slice(offset, offset + limit)
    .map(({ name, path, dirName }) => ({ name, path, dirName }));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ projects: page, total }));
}
