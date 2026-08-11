// Walk a Claude projects tree (…/.claude/projects/**/*.jsonl), collect every
// unique `cwd` value, and mkdir -p each one. Demo seed JSONLs reference paths
// like /home/demo/projects/threadbase-mobile; when PTYManager resumes a
// session it chdirs there, and a missing directory fails the spawn with
// "chdir(2) failed". Deriving the list from the corpus removes the hardcoded
// mkdir block in entrypoint.sh that drifted whenever a new seed was added.
//
// Compiled by tsup to dist/ensure-demo-project-dirs.cjs.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Recursively list *.jsonl files under `root`. */
export function listJsonlFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw err;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile() && name.endsWith(".jsonl")) out.push(full);
      } catch {
        // Skip unreadable entries (races / permissions).
      }
    }
  }
  return out;
}

/**
 * Parse JSONL files under `projectsRoot` and return sorted unique absolute
 * `cwd` strings. Malformed lines and missing `cwd` are skipped.
 */
export function extractDemoCwds(projectsRoot: string): string[] {
  const cwds = new Set<string>();
  for (const file of listJsonlFiles(projectsRoot)) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === "string" && obj.cwd.length > 0 && isAbsolute(obj.cwd)) {
          cwds.add(obj.cwd);
        }
      } catch {
        // Skip corrupt lines — same tolerance the scanner uses.
      }
    }
  }
  return [...cwds].sort();
}

/** Extract cwds from `projectsRoot` and create each directory. Returns the list. */
export function ensureDemoProjectDirs(projectsRoot: string): string[] {
  const cwds = extractDemoCwds(projectsRoot);
  for (const cwd of cwds) {
    mkdirSync(cwd, { recursive: true });
  }
  return cwds;
}

function main(): void {
  const projectsRoot = process.env.DEMO_PROJECTS_ROOT ?? process.argv[2];
  if (!projectsRoot) {
    console.error("[entrypoint] ensure-demo-project-dirs: DEMO_PROJECTS_ROOT or argv[2] required");
    process.exit(1);
  }
  try {
    const cwds = ensureDemoProjectDirs(projectsRoot);
    for (const cwd of cwds) {
      console.log(cwd);
    }
  } catch (err) {
    console.error(`[entrypoint] ${(err as Error).message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
