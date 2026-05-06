import { compareDesc, isValid, parseISO } from "date-fns";

/**
 * Parse an ISO timestamp string. Returns null for null/undefined input or
 * an unparseable value rather than throwing — callers can fall back.
 */
export function parseIsoDateOrNull(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

/**
 * Compare two ISO timestamp strings descending. Null/undefined values sort
 * last regardless of order. Used for ProjectChat list ordering and latest
 * conversation selection.
 */
export function compareIsoDesc(a?: string | null, b?: string | null): number {
  const dateA = parseIsoDateOrNull(a);
  const dateB = parseIsoDateOrNull(b);

  if (!dateA && !dateB) return 0;
  if (!dateA) return 1;
  if (!dateB) return -1;

  return compareDesc(dateA, dateB);
}
