/**
 * Metadata export and restore (C9).
 *
 * Threadbase owns very little durable state, and knowing exactly which parts
 * matter is the whole design:
 *
 *  - **Provider history** (`~/.claude/projects/*.jsonl`, Codex rollouts) is the
 *    authoritative record of every conversation, and it is NOT ours. It is
 *    written by the provider CLIs and survives independently of this server.
 *    Exporting it would duplicate gigabytes of data the user already has, in a
 *    format we do not control.
 *  - **Threadbase metadata** (the `projects` table: stable project ids,
 *    names, and their mapping to paths) is ours, is small, and cannot be
 *    reconstructed — a fresh scan invents new project ids, breaking every
 *    deep link and per-project setting that referenced the old ones.
 *  - **The cache** (conversation metadata, tails, offset index) is derived
 *    entirely from provider history and is rebuilt by scanning. Exporting it
 *    would bloat a backup with data that regenerates itself.
 *
 * So an export carries metadata only, and the restore path is explicit that
 * conversations come back by rescanning provider history rather than from the
 * archive.
 *
 * Credentials are never exported by default. The API key is a live credential
 * whose disclosure grants full control of the server; a backup file gets copied
 * to cloud storage, pasted into issues, and emailed around.
 */

export const BACKUP_FORMAT_VERSION = 1;

export interface BackupProject {
  id: string;
  path: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  streamerVersion: string;
  /** Identity of the machine this was taken from, for path-remap decisions. */
  sourceHost: string;
  /**
   * True when the operator explicitly opted into including secrets. Recorded so
   * a restore can warn, and so an archive's sensitivity is self-describing
   * rather than inferred.
   */
  includesSecrets: boolean;
  counts: { projects: number };
}

export interface BackupArchive {
  manifest: BackupManifest;
  projects: BackupProject[];
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Validate an archive before any of it is applied.
 *
 * Restore is destructive in the sense that it rewrites project identity, so a
 * malformed archive must be rejected whole rather than applied halfway. This
 * checks shape and version up front; the caller applies inside a transaction.
 */
export function validateArchive(input: unknown): BackupArchive {
  if (!input || typeof input !== "object") {
    throw new BackupError("Backup is not an object", "INVALID_ARCHIVE");
  }
  const archive = input as Partial<BackupArchive>;
  const manifest = archive.manifest;

  if (!manifest || typeof manifest !== "object") {
    throw new BackupError("Backup is missing its manifest", "INVALID_ARCHIVE");
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    // Refuse rather than guess. A future format may mean something different by
    // the same field names, and silently misreading it would corrupt project
    // identity in a way the user cannot see.
    throw new BackupError(
      `Unsupported backup format version ${String(manifest.formatVersion)}; this build reads version ${BACKUP_FORMAT_VERSION}`,
      "UNSUPPORTED_VERSION",
    );
  }
  if (!Array.isArray(archive.projects)) {
    throw new BackupError("Backup is missing its projects array", "INVALID_ARCHIVE");
  }

  for (const [i, p] of archive.projects.entries()) {
    if (!p || typeof p !== "object") {
      throw new BackupError(`Project at index ${i} is not an object`, "INVALID_ARCHIVE");
    }
    if (typeof p.id !== "string" || p.id.length === 0) {
      throw new BackupError(`Project at index ${i} has no id`, "INVALID_ARCHIVE");
    }
    if (typeof p.path !== "string" || p.path.length === 0) {
      throw new BackupError(`Project at index ${i} has no path`, "INVALID_ARCHIVE");
    }
  }

  const ids = new Set(archive.projects.map((p) => p.id));
  if (ids.size !== archive.projects.length) {
    // Duplicate ids would make restore order-dependent, so the archive is
    // rejected rather than silently resolved by last-write-wins.
    throw new BackupError("Backup contains duplicate project ids", "INVALID_ARCHIVE");
  }

  return archive as BackupArchive;
}

/**
 * Rewrite project paths from one machine's layout to another's.
 *
 * A backup restored onto a different machine — or the same machine after a home
 * directory move — carries paths that no longer exist. Without remapping, every
 * project points at nothing and the restore is useless.
 *
 * Longest-prefix wins, so a more specific rule beats a general one. Paths that
 * match no rule are left untouched rather than mangled.
 */
export function remapPaths(
  projects: BackupProject[],
  rules: ReadonlyArray<{ from: string; to: string }>,
): BackupProject[] {
  const ordered = [...rules].sort((a, b) => b.from.length - a.from.length);
  return projects.map((p) => {
    const rule = ordered.find((r) => p.path === r.from || p.path.startsWith(`${r.from}/`));
    if (!rule) return p;
    return { ...p, path: `${rule.to}${p.path.slice(rule.from.length)}` };
  });
}

/**
 * Classify how each incoming project relates to what already exists.
 *
 * Returned rather than applied so the caller can show the user what a restore
 * would do before doing it — a restore that silently rewrites project identity
 * is one the user cannot review.
 */
export interface RestorePlan {
  create: BackupProject[];
  /** Same id, different path — the machine-move case. */
  update: BackupProject[];
  /** Path already claimed by a DIFFERENT id. Requires an explicit decision. */
  conflict: Array<{ incoming: BackupProject; existingId: string }>;
}

export function planRestore(
  incoming: BackupProject[],
  existing: ReadonlyArray<{ id: string; path: string }>,
): RestorePlan {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byPath = new Map(existing.map((e) => [e.path, e]));

  const plan: RestorePlan = { create: [], update: [], conflict: [] };

  for (const p of incoming) {
    const sameId = byId.get(p.id);
    if (sameId) {
      if (sameId.path !== p.path) plan.update.push(p);
      continue;
    }
    const samePath = byPath.get(p.path);
    if (samePath) {
      // Two different ids for one path: applying either would break whichever
      // links used the other. The user has to decide.
      plan.conflict.push({ incoming: p, existingId: samePath.id });
      continue;
    }
    plan.create.push(p);
  }

  return plan;
}
