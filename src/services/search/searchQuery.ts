import type { ProviderName } from "../../providers";
import { isProviderName } from "../../providers";

/**
 * Search query parsing, pagination, and filters (C8).
 *
 * `/api/search` returned `{ hasMore: false, offset: 0, total: results.length }`
 * with all three values hardcoded. That was not merely unimplemented — it was
 * actively wrong: the scanner truncates at `limit`, so a query with more matches
 * than the limit reported `hasMore: false` and `total` equal to the truncated
 * count. A client had no way to learn that results were missing, let alone
 * fetch them.
 *
 * The scanner also already computes a relevance `score` and match `snippets`
 * per result, and the endpoint discarded both — so results arrived in an
 * unexplained order with no indication of *why* anything matched.
 */

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;
export const MAX_QUERY_LENGTH = 256;

export interface SearchFilters {
  provider?: ProviderName;
  projectPath?: string;
  branch?: string;
  /** Inclusive lower bound on last activity, epoch ms. */
  since?: number;
  /** Inclusive upper bound on last activity, epoch ms. */
  until?: number;
}

export interface ParsedSearchQuery {
  q: string;
  limit: number;
  offset: number;
  filters: SearchFilters;
}

export class SearchQueryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function intOr(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse and validate search parameters.
 *
 * Rejects rather than silently clamping an invalid query, so a client that
 * mistypes a filter learns about it instead of receiving plausible-looking
 * results for a query it did not mean. `limit` is the exception: it is clamped,
 * because an over-large limit is a resource question rather than a
 * misunderstanding, and failing a search over it would be unhelpful.
 */
export function parseSearchQuery(params: URLSearchParams): ParsedSearchQuery {
  const q = (params.get("q") ?? "").trim();
  if (!q) {
    throw new SearchQueryError("Missing query parameter: q", "invalid_query");
  }
  if (q.length > MAX_QUERY_LENGTH) {
    throw new SearchQueryError(`Query exceeds ${MAX_QUERY_LENGTH} characters`, "query_too_long");
  }

  const limit = Math.min(
    Math.max(intOr(params.get("limit"), DEFAULT_SEARCH_LIMIT), 1),
    MAX_SEARCH_LIMIT,
  );
  const offset = Math.max(intOr(params.get("offset"), 0), 0);

  const filters: SearchFilters = {};

  const provider = params.get("provider");
  if (provider !== null) {
    if (!isProviderName(provider)) {
      throw new SearchQueryError(`Unknown provider: ${provider}`, "invalid_filter");
    }
    filters.provider = provider;
  }

  const projectPath = params.get("projectPath");
  if (projectPath) filters.projectPath = projectPath;

  const branch = params.get("branch");
  if (branch) filters.branch = branch;

  for (const [key, field] of [
    ["since", "since"],
    ["until", "until"],
  ] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) {
      throw new SearchQueryError(`Invalid ${key}: expected an ISO 8601 date`, "invalid_filter");
    }
    filters[field] = ms;
  }

  if (filters.since != null && filters.until != null && filters.since > filters.until) {
    throw new SearchQueryError("`since` must not be after `until`", "invalid_filter");
  }

  return { q, limit, offset, filters };
}

/** A search result as returned to clients, after adaptation. */
export interface AdaptedResult {
  projectPath?: string;
  branch?: string;
  provider?: string;
  lastActivity?: string | number | null;
}

/**
 * Apply the filters the scanner cannot express itself.
 *
 * The scanner's SearchOptions supports `provider` but not project, branch, or
 * date bounds, so those are applied here. Filtering after the fact means the
 * scanner's own limit must be raised before slicing — see `handleSearch` — or
 * a filter would silently drop results that a later page should have contained.
 */
export function applyFilters<T extends AdaptedResult>(results: T[], filters: SearchFilters): T[] {
  return results.filter((r) => {
    if (filters.provider && r.provider !== filters.provider) return false;
    if (filters.projectPath && r.projectPath !== filters.projectPath) return false;
    if (filters.branch && r.branch !== filters.branch) return false;

    if (filters.since != null || filters.until != null) {
      const ts = r.lastActivity == null ? Number.NaN : new Date(r.lastActivity).getTime();
      // A result with no usable timestamp cannot be shown to satisfy a date
      // bound, so exclude it rather than guessing.
      if (Number.isNaN(ts)) return false;
      if (filters.since != null && ts < filters.since) return false;
      if (filters.until != null && ts > filters.until) return false;
    }
    return true;
  });
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Slice a filtered result set into a page.
 *
 * `total` is the count AFTER filtering and BEFORE slicing, and `hasMore` is
 * derived from it — the two values the previous implementation hardcoded to
 * `results.length` and `false`.
 */
export function paginate<T>(results: T[], offset: number, limit: number): Page<T> {
  const items = results.slice(offset, offset + limit);
  return {
    items,
    total: results.length,
    offset,
    hasMore: offset + items.length < results.length,
  };
}
