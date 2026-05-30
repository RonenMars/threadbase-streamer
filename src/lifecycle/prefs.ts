import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { getLogger } from "../logger";
import { prefsPath } from "./constants";

const log = getLogger("lifecycle.prefs");

export const PrefsSchema = z.object({
  repos: z.record(
    z.string(),
    z.object({
      choice: z.enum(["replace-prod", "use-port"]),
      port: z.number().int().positive().optional(),
      rememberedAt: z.string().datetime(),
    }),
  ),
});

export type Prefs = z.infer<typeof PrefsSchema>;
export type RepoChoice = { choice: "replace-prod" } | { choice: "use-port"; port: number };

export function readPrefs(): Prefs {
  const path = prefsPath();
  if (!existsSync(path)) return { repos: {} };
  try {
    return PrefsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    log.warn(`prefs at ${path} are malformed; treating as empty`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { repos: {} };
  }
}

function savePrefs(p: Prefs): void {
  const path = prefsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writePrefForRepo(repoToplevel: string, choice: RepoChoice): void {
  const p = readPrefs();
  p.repos[repoToplevel] = {
    ...choice,
    rememberedAt: new Date().toISOString(),
  };
  savePrefs(p);
}

export function getPrefForRepo(repoToplevel: string | null) {
  if (!repoToplevel) return null;
  return readPrefs().repos[repoToplevel] ?? null;
}

export function forgetRepo(repoToplevel: string): void {
  const p = readPrefs();
  delete p.repos[repoToplevel];
  savePrefs(p);
}

export function forgetAll(): void {
  const path = prefsPath();
  if (existsSync(path)) rmSync(path);
}
