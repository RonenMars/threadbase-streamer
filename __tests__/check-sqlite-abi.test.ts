import { checkSqliteAbi, isAbiMismatch, SqliteAbiError } from "../src/db/check-sqlite-abi";

describe("isAbiMismatch", () => {
  it("matches the NODE_MODULE_VERSION error text", () => {
    expect(
      isAbiMismatch(
        "The module '...' was compiled against a different Node.js version using NODE_MODULE_VERSION 147.",
      ),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isAbiMismatch("SQLITE_CANTOPEN: unable to open database file")).toBe(false);
    expect(isAbiMismatch("disk I/O error")).toBe(false);
  });
});

describe("SqliteAbiError", () => {
  it("names the rebuild command and running Node", () => {
    const err = new SqliteAbiError("NODE_MODULE_VERSION 147");
    expect(err).toBeInstanceOf(SqliteAbiError);
    expect(err.message).toContain("npm rebuild better-sqlite3");
    expect(err.message).toContain(process.version);
  });
});

describe("checkSqliteAbi", () => {
  it("passes with the installed (rebuilt) better-sqlite3 binary", () => {
    // If the binary is ABI-broken this throws SqliteAbiError, which is exactly
    // the signal the preflight exists to give — so a green run here also proves
    // the local node_modules matches the running Node.
    expect(() => checkSqliteAbi()).not.toThrow();
  });
});
