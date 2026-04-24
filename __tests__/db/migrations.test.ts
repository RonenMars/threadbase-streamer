import { readdirSync, readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const mockPool = { query: mockQuery };

vi.mock("fs", () => ({
  readdirSync: vi.fn(() => ["001_create_managed_sessions.sql"]),
  readFileSync: vi.fn(() => "CREATE TABLE managed_sessions (id TEXT);"),
}));

import { runMigrations } from "../../src/db/migrations";

describe("db/migrations", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(readdirSync).mockReturnValue(["001_create_managed_sessions.sql"] as any);
    vi.mocked(readFileSync).mockReturnValue("CREATE TABLE managed_sessions (id TEXT);");
  });

  it("creates _migrations table if not exists", async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await runMigrations(mockPool as any, "/fake/migrations");

    expect(mockQuery.mock.calls[0][0]).toContain("CREATE TABLE IF NOT EXISTS _migrations");
  });

  it("skips already-applied migrations", async () => {
    mockQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({
      rows: [{ name: "001_create_managed_sessions.sql" }],
    });

    await runMigrations(mockPool as any, "/fake/migrations");

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("applies unapplied migrations in order", async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await runMigrations(mockPool as any, "/fake/migrations");

    expect(mockQuery.mock.calls[2][0]).toContain("CREATE TABLE managed_sessions");
    expect(mockQuery.mock.calls[3][0]).toContain("INSERT INTO _migrations");
    expect(mockQuery.mock.calls[3][1]).toContain("001_create_managed_sessions.sql");
  });

  it("applies multiple migrations in alphabetical order", async () => {
    vi.mocked(readdirSync).mockReturnValue(["002_add_index.sql", "001_create_table.sql"] as any);
    vi.mocked(readFileSync)
      .mockReturnValueOnce("CREATE TABLE t;")
      .mockReturnValueOnce("CREATE INDEX i;");

    // create _migrations, select applied (none), then 2x (execute + insert record)
    mockQuery
      .mockResolvedValueOnce({}) // create _migrations
      .mockResolvedValueOnce({ rows: [] }) // select applied
      .mockResolvedValueOnce({}) // execute 001
      .mockResolvedValueOnce({}) // insert 001
      .mockResolvedValueOnce({}) // execute 002
      .mockResolvedValueOnce({}); // insert 002

    await runMigrations(mockPool as any, "/fake/migrations");

    // Files should be sorted: 001 first, then 002
    expect(mockQuery.mock.calls[3][1]).toContain("001_create_table.sql");
    expect(mockQuery.mock.calls[5][1]).toContain("002_add_index.sql");
  });

  it("only applies unapplied when some already exist", async () => {
    vi.mocked(readdirSync).mockReturnValue(["001_create_table.sql", "002_add_index.sql"] as any);
    vi.mocked(readFileSync).mockReturnValue("CREATE INDEX i;");

    mockQuery
      .mockResolvedValueOnce({}) // create _migrations
      .mockResolvedValueOnce({ rows: [{ name: "001_create_table.sql" }] }) // 001 already applied
      .mockResolvedValueOnce({}) // execute 002
      .mockResolvedValueOnce({}); // insert 002

    await runMigrations(mockPool as any, "/fake/migrations");

    // Only 002 should be applied (4 calls total, not 6)
    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(mockQuery.mock.calls[3][1]).toContain("002_add_index.sql");
  });

  it("ignores non-sql files", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      "001_create_table.sql",
      "README.md",
      ".gitkeep",
    ] as any);

    mockQuery
      .mockResolvedValueOnce({}) // create _migrations
      .mockResolvedValueOnce({ rows: [] }) // select applied
      .mockResolvedValueOnce({}) // execute 001
      .mockResolvedValueOnce({}); // insert 001

    await runMigrations(mockPool as any, "/fake/migrations");

    // Only 1 migration applied (4 calls: create table, select, execute, insert)
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });
});
