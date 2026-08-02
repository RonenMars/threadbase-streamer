import { describe, expect, it } from "vitest";
import {
  applyFilters,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  paginate,
  parseSearchQuery,
  SearchQueryError,
} from "../src/services/search/searchQuery";

/**
 * Search pagination and filters (C8).
 *
 * /api/search returned { hasMore: false, offset: 0, total: results.length } with
 * all three hardcoded. That was actively wrong rather than merely missing: the
 * scanner truncates at `limit`, so a query with more matches than the limit
 * reported hasMore:false and a total equal to the truncated count — a client
 * could not learn that results were missing, let alone fetch them.
 */

const params = (s: string) => new URLSearchParams(s);

describe("parseSearchQuery", () => {
  it("requires a query", () => {
    expect(() => parseSearchQuery(params(""))).toThrow(SearchQueryError);
    expect(() => parseSearchQuery(params("q=%20%20"))).toThrow(/Missing query/);
  });

  it("rejects an over-long query", () => {
    const long = "x".repeat(257);
    expect(() => parseSearchQuery(params(`q=${long}`))).toThrow(/exceeds/);
  });

  it("defaults limit and offset", () => {
    const parsed = parseSearchQuery(params("q=hello"));
    expect(parsed.limit).toBe(DEFAULT_SEARCH_LIMIT);
    expect(parsed.offset).toBe(0);
  });

  // An over-large limit is a resource question, not a misunderstanding —
  // failing the search over it would be unhelpful.
  it("clamps limit rather than failing", () => {
    expect(parseSearchQuery(params("q=a&limit=99999")).limit).toBe(MAX_SEARCH_LIMIT);
    expect(parseSearchQuery(params("q=a&limit=0")).limit).toBe(1);
    expect(parseSearchQuery(params("q=a&limit=nonsense")).limit).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it("never returns a negative offset", () => {
    expect(parseSearchQuery(params("q=a&offset=-5")).offset).toBe(0);
  });

  // A mistyped filter must not silently return plausible results for a query
  // the client did not mean.
  it("rejects an unknown provider rather than ignoring it", () => {
    expect(() => parseSearchQuery(params("q=a&provider=gpt-cli"))).toThrow(/Unknown provider/);
  });

  it("accepts known providers", () => {
    expect(parseSearchQuery(params("q=a&provider=codex-cli")).filters.provider).toBe("codex-cli");
  });

  it("parses project and branch filters", () => {
    const f = parseSearchQuery(params("q=a&projectPath=/w/repo&branch=main")).filters;
    expect(f.projectPath).toBe("/w/repo");
    expect(f.branch).toBe("main");
  });

  it("parses ISO date bounds", () => {
    const f = parseSearchQuery(params("q=a&since=2026-07-01T00:00:00Z")).filters;
    expect(f.since).toBe(Date.parse("2026-07-01T00:00:00Z"));
  });

  it("rejects an unparseable date", () => {
    expect(() => parseSearchQuery(params("q=a&since=last-tuesday"))).toThrow(/ISO 8601/);
  });

  it("rejects an inverted date range", () => {
    expect(() =>
      parseSearchQuery(params("q=a&since=2026-07-10T00:00:00Z&until=2026-07-01T00:00:00Z")),
    ).toThrow(/must not be after/);
  });
});

describe("applyFilters", () => {
  const rows = [
    {
      provider: "claude-code",
      projectPath: "/a",
      branch: "main",
      lastActivity: "2026-07-10T00:00:00Z",
    },
    {
      provider: "codex-cli",
      projectPath: "/b",
      branch: "dev",
      lastActivity: "2026-07-20T00:00:00Z",
    },
  ];

  it("filters by provider, project, and branch", () => {
    expect(applyFilters(rows, { provider: "codex-cli" })).toHaveLength(1);
    expect(applyFilters(rows, { projectPath: "/a" })[0].branch).toBe("main");
    expect(applyFilters(rows, { branch: "dev" })[0].provider).toBe("codex-cli");
  });

  it("filters by date bounds inclusively", () => {
    expect(applyFilters(rows, { since: Date.parse("2026-07-15T00:00:00Z") })).toHaveLength(1);
    expect(applyFilters(rows, { until: Date.parse("2026-07-15T00:00:00Z") })).toHaveLength(1);
    expect(applyFilters(rows, { since: Date.parse("2026-07-10T00:00:00Z") })).toHaveLength(2);
  });

  // A result with no usable timestamp cannot be shown to satisfy a date bound,
  // so it is excluded rather than guessed at.
  it("excludes results with no usable timestamp when a date bound is set", () => {
    const undated = [{ provider: "claude-code", lastActivity: null }];
    expect(applyFilters(undated, { since: 0 })).toHaveLength(0);
    // With no date filter it is kept.
    expect(applyFilters(undated, {})).toHaveLength(1);
  });

  it("returns everything when no filters are set", () => {
    expect(applyFilters(rows, {})).toHaveLength(2);
  });
});

describe("paginate", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i }));

  // The heart of the bug: total must be the count BEFORE slicing, and hasMore
  // must be derived from it.
  it("reports the pre-slice total and a correct hasMore", () => {
    const page = paginate(rows, 0, 3);
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(true);
  });

  it("reports hasMore false on the last page", () => {
    const page = paginate(rows, 8, 5);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("handles an offset past the end", () => {
    const page = paginate(rows, 50, 5);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(false);
  });

  it("pages through the whole set without gaps or repeats", () => {
    const seen: number[] = [];
    for (let offset = 0; ; offset += 4) {
      const page = paginate(rows, offset, 4);
      seen.push(...page.items.map((r) => r.i));
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(rows.map((r) => r.i));
  });
});
