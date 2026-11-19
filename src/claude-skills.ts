import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { parse as parseYaml } from "yaml";

/** One entry of Claude Code's `/` menu that comes from a file on disk. */
export interface ClaudeSkill {
  name: string;
  description: string;
  argumentHint?: string;
  source: "user" | "project" | "plugin";
}

interface Parsed {
  meta: Record<string, unknown>;
  body: string;
}

function parseMarkdown(path: string): Parsed | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  let meta: unknown;
  try {
    meta = parseYaml(match[1]);
  } catch {
    meta = {};
  }
  return {
    meta: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {},
    body: text.slice(match[0].length),
  };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory(); // follows symlinks
  } catch {
    return false;
  }
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function toSkill(
  parsed: Parsed,
  name: string,
  source: ClaudeSkill["source"],
  fallbackDescription = "",
): ClaudeSkill | null {
  if (parsed.meta["user-invocable"] === false) return null;
  const description =
    typeof parsed.meta.description === "string" ? parsed.meta.description : fallbackDescription;
  const hint = parsed.meta["argument-hint"];
  return {
    name,
    description,
    ...(typeof hint === "string" && hint ? { argumentHint: hint } : {}),
    source,
  };
}

/** `<dir>/<name>/SKILL.md`; the frontmatter `name` wins over the folder name. */
function readSkillsDir(dir: string, source: ClaudeSkill["source"], prefix = ""): ClaudeSkill[] {
  const out: ClaudeSkill[] = [];
  for (const entry of listNames(dir)) {
    const folder = join(dir, entry);
    if (!isDir(folder)) continue;
    const parsed = parseMarkdown(join(folder, "SKILL.md"));
    if (!parsed) continue;
    const own = typeof parsed.meta.name === "string" && parsed.meta.name ? parsed.meta.name : entry;
    const s = toSkill(parsed, prefix + own, source);
    if (s) out.push(s);
  }
  return out;
}

/** `<dir>/**\/*.md`; `a/b.md` is the command `a:b`. */
function readCommandsDir(dir: string, source: ClaudeSkill["source"], prefix = ""): ClaudeSkill[] {
  const out: ClaudeSkill[] = [];
  const walk = (current: string) => {
    for (const entry of listNames(current)) {
      const path = join(current, entry);
      if (isDir(path)) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const parsed = parseMarkdown(path);
      if (!parsed) continue;
      const name = relative(dir, path).slice(0, -3).split(sep).join(":");
      const firstLine =
        parsed.body
          .split(/\r?\n/)
          .map((l) => l.replace(/^#+\s*/, "").trim())
          .find(Boolean) ?? "";
      const s = toSkill(parsed, prefix + name, source, firstLine);
      if (s) out.push(s);
    }
  };
  walk(dir);
  return out;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function enabledPlugins(home: string, projectPath: string): Map<string, boolean> {
  const enabled = new Map<string, boolean>();
  for (const settings of [
    join(home, ".claude", "settings.json"),
    join(projectPath, ".claude", "settings.json"),
    join(projectPath, ".claude", "settings.local.json"),
  ]) {
    const map = readJson(settings).enabledPlugins;
    if (!map || typeof map !== "object") continue;
    for (const [id, on] of Object.entries(map)) enabled.set(id, on === true);
  }
  return enabled;
}

function readPlugins(home: string, projectPath: string): ClaudeSkill[] {
  const installed = readJson(join(home, ".claude", "plugins", "installed_plugins.json")).plugins;
  if (!installed || typeof installed !== "object") return [];
  const enabled = enabledPlugins(home, projectPath);
  const out: ClaudeSkill[] = [];
  for (const [id, installs] of Object.entries(installed)) {
    if (!enabled.get(id)) continue;
    const installPath = Array.isArray(installs) ? installs[0]?.installPath : undefined;
    if (typeof installPath !== "string" || !existsSync(installPath)) continue;
    const prefix = `${id.split("@")[0]}:`;
    // ponytail: default skills/ and commands/ dirs only; read the manifest's custom paths if a plugin's list comes up short.
    out.push(...readSkillsDir(join(installPath, "skills"), "plugin", prefix));
    out.push(...readCommandsDir(join(installPath, "commands"), "plugin", prefix));
  }
  return out;
}

/**
 * The skills and custom commands Claude Code offers on `/` for a session in
 * `projectPath`, read from the same files the CLI reads. Precedence follows the
 * Claude Code docs: personal over project, and a skill over a command of the
 * same name. Plugin entries are `plugin:name`, so they never collide.
 * ponytail: only `<projectPath>/.claude`, not nested or ancestor `.claude` dirs.
 */
export function listClaudeSkills({
  home,
  projectPath,
}: {
  home: string;
  projectPath: string;
}): ClaudeSkill[] {
  const ordered = [
    ...readSkillsDir(join(home, ".claude", "skills"), "user"),
    ...readSkillsDir(join(projectPath, ".claude", "skills"), "project"),
    ...readCommandsDir(join(home, ".claude", "commands"), "user"),
    ...readCommandsDir(join(projectPath, ".claude", "commands"), "project"),
    ...readPlugins(home, projectPath),
  ];
  const byName = new Map<string, ClaudeSkill>();
  for (const s of ordered) if (!byName.has(s.name)) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
