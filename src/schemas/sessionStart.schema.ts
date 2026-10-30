import { z } from "zod";

/**
 * Upper bound on directories a session may be given beyond its working
 * directory. Code, not config: each one becomes an `--add-dir` argument and a
 * path the agent may write to.
 */
export const MAX_ADDITIONAL_PATHS = 8;

/** `additionalPaths` on POST /api/sessions/start and /api/sessions/resume. */
export const AdditionalPathsSchema = z.array(z.string().trim().min(1)).max(MAX_ADDITIONAL_PATHS);
