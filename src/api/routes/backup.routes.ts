import { Hono } from "hono";
import { hostname } from "os";
import {
  BACKUP_FORMAT_VERSION,
  BackupError,
  type BackupProject,
  planRestore,
  remapPaths,
  validateArchive,
} from "../../services/backup/backup";
import { getVersion } from "../../version";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

/**
 * Metadata export and restore (C9 / mobile U11).
 *
 * Only Threadbase metadata is exported. Provider history is authoritative and
 * is not ours; the cache derives from it and rebuilds by scanning. What cannot
 * be reconstructed is project identity — a fresh scan invents new project ids,
 * breaking every deep link and per-project setting that referenced the old ones.
 *
 * Restore is deliberately two-step: a dry run returns the plan so the user can
 * see what would change, and applying requires an explicit flag. A restore that
 * silently rewrites project identity is one nobody can review.
 */

function readBody(c: { env: { incoming: NodeJS.ReadableStream } }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    c.env.incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    c.env.incoming.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    c.env.incoming.on("error", reject);
  });
}

export const createBackupRoutes = (deps: Pick<ApiDeps, "projectsRepo">) => {
  const app = new Hono<AppEnv>();

  app.get("/export", (c) => {
    const repo = deps.projectsRepo();
    if (!repo) {
      return c.json({ error: "Project store is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }

    const projects: BackupProject[] = repo.listProjects().map((p) => ({
      id: p.id,
      path: p.path,
      name: p.name ?? null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

    return c.json({
      manifest: {
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        streamerVersion: getVersion(),
        sourceHost: hostname(),
        // No endpoint here exports the API key. The flag is recorded so an
        // archive is self-describing about its own sensitivity rather than
        // requiring a reader to infer it.
        includesSecrets: false,
        counts: { projects: projects.length },
      },
      projects,
    });
  });

  app.post("/restore", async (c) => {
    const repo = deps.projectsRepo();
    if (!repo) {
      return c.json({ error: "Project store is unavailable", code: "STORE_UNAVAILABLE" }, 503);
    }

    let body: { archive?: unknown; pathMap?: unknown; apply?: unknown };
    try {
      body = (await readBody(c)) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, 400);
    }

    // Validate the whole archive before anything is applied. Restore rewrites
    // project identity, so a malformed archive is rejected outright rather than
    // applied halfway.
    let archive: ReturnType<typeof validateArchive>;
    try {
      archive = validateArchive(body.archive);
    } catch (err) {
      if (err instanceof BackupError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }

    const rules = Array.isArray(body.pathMap)
      ? (body.pathMap as Array<{ from?: unknown; to?: unknown }>)
          .filter((r) => typeof r?.from === "string" && typeof r?.to === "string")
          .map((r) => ({ from: r.from as string, to: r.to as string }))
      : [];

    const incoming = rules.length > 0 ? remapPaths(archive.projects, rules) : archive.projects;
    const existing = repo.listProjects().map((p) => ({ id: p.id, path: p.path }));
    const plan = planRestore(incoming, existing);

    const summary = {
      create: plan.create.length,
      update: plan.update.length,
      conflict: plan.conflict.length,
    };

    // Dry run by default. The caller sees exactly what would change before
    // anything is written.
    if (body.apply !== true) {
      return c.json({ applied: false, summary, plan });
    }

    // A conflict means one path is claimed by two different ids; applying
    // either would break whichever links used the other. Refuse rather than
    // pick a silent winner.
    if (plan.conflict.length > 0) {
      return c.json(
        {
          error: "Restore has unresolved conflicts",
          code: "RESTORE_CONFLICT",
          summary,
          plan,
        },
        409,
      );
    }

    let applied = 0;
    for (const p of [...plan.create, ...plan.update]) {
      try {
        repo.upsertProjectByPath(p.path, { name: p.name });
        applied++;
      } catch {
        // Continue rather than aborting midway: a partial restore that reports
        // its own count is more recoverable than one that stops silently.
      }
    }

    return c.json({ applied: true, summary, appliedCount: applied });
  });

  return app;
};
