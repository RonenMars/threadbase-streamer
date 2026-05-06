import type { ProjectChat } from "../../schemas/projectChat.schema";
import { compareIsoDesc } from "../../utils/dates";

/**
 * Stable sort comparator for ProjectChats.
 *
 * Order:
 *   1. latestMessageAt DESC
 *   2. updatedAt DESC
 *   3. createdAt DESC
 *   4. title ASC
 */
export function sortProjectChats(a: ProjectChat, b: ProjectChat): number {
  const byLatest = compareIsoDesc(a.latestMessageAt, b.latestMessageAt);
  if (byLatest !== 0) return byLatest;

  const byUpdated = compareIsoDesc(a.updatedAt ?? null, b.updatedAt ?? null);
  if (byUpdated !== 0) return byUpdated;

  const byCreated = compareIsoDesc(a.createdAt ?? null, b.createdAt ?? null);
  if (byCreated !== 0) return byCreated;

  return a.title.localeCompare(b.title);
}
