import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SLOW_QUERY_MS, instrumentDatabase, labelStatements } from "../src/db/query-timing";

// The whole point of this module is what it writes to the log, so the log is
// what the tests read. Captured at the logger boundary: pino's own destination
// bypasses process.stdout under vitest and can't be spied on.
const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any; dest?: string }>,
  debugEnabled: false,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any, dest?: string) =>
    h.calls.push({ level, msg, fields, dest });
  return {
    getLogger: () => ({
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      log: () => {},
      pino: { isLevelEnabled: () => h.debugEnabled },
    }),
  };
});

// Any real query beats this, so "slow" is deterministic rather than a race.
const ALWAYS_SLOW = 0.0001;

const eventsOf = (event: string) => h.calls.filter((c) => c.fields?.event === event);

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
  const insert = db.prepare("INSERT INTO t (id, n) VALUES (?, ?)");
  insert.run("a", 1);
  insert.run("b", 2);
  insert.run("c", 3);
  return db;
}

let db: Database.Database;

beforeEach(() => {
  h.calls.length = 0;
  h.debugEnabled = false;
  db = seed();
});

afterEach(() => {
  db.close();
  delete process.env.THREADBASE_DB_SLOW_QUERY_MS;
});

describe("instrumentDatabase", () => {
  it("logs a slow query at warn with the statement's name, duration and row count", () => {
    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });
    const stmts = { listRows: db.prepare("SELECT * FROM t ORDER BY n") };
    labelStatements(stmts);

    stmts.listRows.all();

    const [line] = eventsOf("db.slow_query");
    expect(line.level).toBe("warn");
    expect(line.fields).toMatchObject({ stmt: "listRows", rows: 3 });
    expect(line.fields.ms).toBeGreaterThanOrEqual(0);
  });

  it("writes structured-only, never duplicating the line through console", () => {
    // dest "both" is the logger default and would put every slow-query line in
    // the prod log twice — pino's copy and console's. This log has no rotation.
    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });
    h.debugEnabled = true;
    db.prepare("SELECT * FROM t").all();
    db.prepare("SELECT * FROM t").get();

    expect(h.calls).not.toHaveLength(0);
    for (const call of h.calls) expect(call.dest).toBe("pino");
  });

  it("never logs the SQL text or the bound parameters", () => {
    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });
    const stmts = { getById: db.prepare("SELECT * FROM t WHERE id = ?") };
    labelStatements(stmts);

    // A parameter shaped like what we refuse to log: a real conversation path.
    stmts.getById.get("/Users/someone/.claude/projects/secret-project/abc-123.jsonl");

    const serialized = JSON.stringify(h.calls);
    expect(serialized).not.toContain("secret-project");
    expect(serialized).not.toContain("SELECT * FROM t");
  });

  it("falls back to a verb:table label for statements nobody named", () => {
    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });

    db.prepare("SELECT * FROM t WHERE id = ?").get("a");
    db.prepare("UPDATE t SET n = 9 WHERE id = ?").run("a");
    db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("d", 4);
    db.prepare("DELETE FROM t WHERE id = ?").run("d");

    expect(eventsOf("db.slow_query").map((c) => c.fields.stmt)).toEqual([
      "select:t",
      "update:t",
      "insert:t",
      "delete:t",
    ]);
  });

  it("reports rows per method: all() length, get() 0 or 1, run() changes", () => {
    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });

    db.prepare("SELECT * FROM t").all();
    db.prepare("SELECT * FROM t WHERE id = ?").get("a");
    db.prepare("SELECT * FROM t WHERE id = ?").get("nope");
    db.prepare("DELETE FROM t WHERE n > ?").run(1);

    expect(eventsOf("db.slow_query").map((c) => c.fields.rows)).toEqual([3, 1, 0, 2]);
  });

  it("stays silent below the threshold — a healthy query logs nothing by default", () => {
    instrumentDatabase(db);
    const stmts = { listRows: db.prepare("SELECT * FROM t") };
    labelStatements(stmts);

    stmts.listRows.all();

    expect(DEFAULT_SLOW_QUERY_MS).toBe(35);
    expect(h.calls).toHaveLength(0);
  });

  it("logs every query only when debug is enabled, at debug level", () => {
    instrumentDatabase(db);
    h.debugEnabled = true;
    const stmts = { listRows: db.prepare("SELECT * FROM t") };
    labelStatements(stmts);

    stmts.listRows.all();

    const [line] = eventsOf("db.query");
    expect(line.level).toBe("debug");
    expect(line.fields).toMatchObject({ stmt: "listRows", rows: 3 });
  });

  it("disables slow logging when the threshold is <= 0", () => {
    instrumentDatabase(db, { slowMs: 0 });
    db.prepare("SELECT * FROM t").all();
    expect(eventsOf("db.slow_query")).toHaveLength(0);
  });

  it("reads the threshold from THREADBASE_DB_SLOW_QUERY_MS", () => {
    process.env.THREADBASE_DB_SLOW_QUERY_MS = String(ALWAYS_SLOW);
    instrumentDatabase(db);
    db.prepare("SELECT * FROM t").all();
    expect(eventsOf("db.slow_query")).toHaveLength(1);
  });

  it("ignores an unparseable threshold rather than disabling itself", () => {
    process.env.THREADBASE_DB_SLOW_QUERY_MS = "banana";
    instrumentDatabase(db);
    db.prepare("SELECT * FROM t").all();
    // Fell back to the 35ms default, so this fast query stays quiet.
    expect(eventsOf("db.slow_query")).toHaveLength(0);
  });

  it("returns exactly what the uninstrumented statement returns", () => {
    const plain = seed();
    const expectedAll = plain.prepare("SELECT * FROM t ORDER BY n").all();
    const expectedGet = plain.prepare("SELECT * FROM t WHERE id = ?").get("b");
    const expectedRun = plain.prepare("UPDATE t SET n = 9 WHERE id = ?").run("a");

    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });
    expect(db.prepare("SELECT * FROM t ORDER BY n").all()).toEqual(expectedAll);
    expect(db.prepare("SELECT * FROM t WHERE id = ?").get("b")).toEqual(expectedGet);
    expect(db.prepare("UPDATE t SET n = 9 WHERE id = ?").run("a")).toEqual(expectedRun);
    plain.close();
  });

  it("leaves the statement methods it does not wrap working", () => {
    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });

    expect(db.prepare("SELECT id FROM t ORDER BY id").pluck().all()).toEqual(["a", "b", "c"]);
    expect([...db.prepare("SELECT id FROM t ORDER BY id").iterate()]).toHaveLength(3);
  });

  it("keeps working inside a transaction", () => {
    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });
    const insert = db.prepare("INSERT INTO t (id, n) VALUES (?, ?)");
    db.transaction(() => {
      insert.run("x", 10);
      insert.run("y", 11);
    })();

    expect(db.prepare("SELECT COUNT(*) AS n FROM t").pluck().get()).toBe(5);
  });

  it("does not expose the label box to code that enumerates a statement bag", () => {
    instrumentDatabase(db, { slowMs: ALWAYS_SLOW });
    const stmts = { one: db.prepare("SELECT 1") };
    labelStatements(stmts);

    expect(Object.keys(stmts)).toEqual(["one"]);
    expect(JSON.stringify(stmts.one)).not.toContain("label");
  });
});

describe("labelStatements", () => {
  it("ignores statements from an uninstrumented connection", () => {
    const stmts = { plain: db.prepare("SELECT 1") };
    expect(() => labelStatements(stmts)).not.toThrow();
  });

  it("ignores non-statement values in the bag", () => {
    expect(() => labelStatements({ nope: null, alsoNope: 42, s: "x" })).not.toThrow();
  });
});
