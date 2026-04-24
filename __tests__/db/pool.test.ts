import { describe, expect, it, vi } from "vitest";

const MockPool = vi.fn(() => ({
  query: vi.fn(),
  end: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
}));

vi.mock("pg", () => ({
  default: { Pool: MockPool },
  Pool: MockPool,
}));

import { createPool, maskConnectionString } from "../../src/db/pool";

describe("db/pool", () => {
  describe("maskConnectionString", () => {
    it("masks password in connection string", () => {
      const url = "postgresql://user:secret123@localhost:5432/threadbase";
      expect(maskConnectionString(url)).toBe("postgresql://user:***@localhost:5432/threadbase");
    });

    it("handles connection string without password", () => {
      const url = "postgresql://localhost:5432/threadbase";
      expect(maskConnectionString(url)).toBe("postgresql://localhost:5432/threadbase");
    });

    it("handles connection string with empty password", () => {
      const url = "postgresql://user:@localhost:5432/threadbase";
      expect(maskConnectionString(url)).toBe("postgresql://user:***@localhost:5432/threadbase");
    });

    it("returns masked placeholder for non-URL strings", () => {
      expect(maskConnectionString("not-a-url")).toBe("***masked***");
    });
  });

  describe("createPool", () => {
    beforeEach(() => {
      MockPool.mockClear();
    });

    it("creates a pool with provided config", async () => {
      const pool = await createPool({
        connectionString: "postgresql://localhost:5432/threadbase",
        max: 5,
      });
      expect(pool).toBeDefined();
      expect(pool.end).toBeDefined();
    });

    it("passes ssl rejectUnauthorized:false when ssl is require", async () => {
      await createPool({
        connectionString: "postgresql://localhost:5432/threadbase",
        max: 10,
        ssl: "require",
      });
      expect(MockPool).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: { rejectUnauthorized: false } }),
      );
    });

    it("passes ssl:false when ssl is disable", async () => {
      await createPool({
        connectionString: "postgresql://localhost:5432/threadbase",
        max: 10,
        ssl: "disable",
      });
      expect(MockPool).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
    });

    it("does not set ssl when ssl is undefined", async () => {
      await createPool({
        connectionString: "postgresql://localhost:5432/threadbase",
        max: 10,
      });
      const config = MockPool.mock.calls[0][0];
      expect(config).not.toHaveProperty("ssl");
    });

    it("passes statement_timeout when statementTimeout is set", async () => {
      await createPool({
        connectionString: "postgresql://localhost:5432/threadbase",
        max: 10,
        statementTimeout: 5000,
      });
      expect(MockPool).toHaveBeenCalledWith(expect.objectContaining({ statement_timeout: 5000 }));
    });

    it("does not set statement_timeout when statementTimeout is undefined", async () => {
      await createPool({
        connectionString: "postgresql://localhost:5432/threadbase",
        max: 10,
      });
      const config = MockPool.mock.calls[0][0];
      expect(config).not.toHaveProperty("statement_timeout");
    });
  });
});
