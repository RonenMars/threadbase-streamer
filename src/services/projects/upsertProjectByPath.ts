import type {
  ProjectsRepository,
  UpsertProjectInput,
} from "../../db/repositories/projects.repository";
import type { Project } from "../../schemas/project.schema";

/**
 * Thin adapter so callers can `import { upsertProjectByPath }` without
 * threading the repository instance through every layer. The repository
 * remains the source of truth.
 */
export function upsertProjectByPath(
  repo: ProjectsRepository,
  rawPath: string,
  input: UpsertProjectInput = {},
): Project {
  return repo.upsertProjectByPath(rawPath, input);
}
