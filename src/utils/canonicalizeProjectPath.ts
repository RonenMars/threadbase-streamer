/**
 * Canonicalize a project path so the same project always dedupes to the
 * same key, regardless of trailing slashes or surrounding whitespace.
 *
 * Rules:
 *   - Trim surrounding whitespace
 *   - Remove trailing forward or back slashes (one or more)
 *
 * Do NOT lowercase: project paths can be case-sensitive on Linux/macOS
 * and lowercasing them would silently merge two distinct real projects.
 */
export function canonicalizeProjectPath(projectPath: string): string {
  return projectPath.trim().replace(/[\\/]+$/, "");
}
