import type { ProjectsRepository } from "../../db/repositories/projects.repository";
import type { SessionsRepository } from "../../db/repositories/sessions.repository";
import { canonicalizeProjectPath } from "../../utils/canonicalizeProjectPath";

/**
 * Walk every managed session and, where a session's projectPath maps to
 * an existing project but the session's projectId is missing, link it.
 *
 * Sessions are not the source of project discovery (conversations are),
 * so this never CREATES a project — only links to ones that already
 * exist. Sessions that point at a path with no matching project are left
 * unlinked; the caller can refresh the conversation cache and try again.
 */
export function ensureSessionProjectIdsFromExistingProjects(
  projectsRepo: ProjectsRepository,
  sessionsRepo: SessionsRepository,
): { linked: number; missing: number } {
  let linked = 0;
  let missing = 0;

  for (const session of sessionsRepo.listManagedSessions()) {
    if (session.projectId) continue;
    const canonical = canonicalizeProjectPath(session.projectPath);
    if (!canonical) continue;

    const project = projectsRepo.getProjectByPath(canonical);
    if (!project) {
      missing += 1;
      continue;
    }

    sessionsRepo.updateSessionProjectId({ sessionId: session.id, projectId: project.id });
    linked += 1;
  }

  return { linked, missing };
}
