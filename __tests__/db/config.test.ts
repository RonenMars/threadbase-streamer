import { afterEach, describe, expect, it } from "vitest";
import { getDbConfig, isDbEnabled } from "../../src/db/config";

describe("db/config", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isDbEnabled", () => {
    it("returns false when THREADBASE_DATABASE_URL is not set", () => {
      process.env = { ...originalEnv };
      delete process.env.THREADBASE_DATABASE_URL;
      expect(isDbEnabled()).toBe(false);
    });

    it("returns false when THREADBASE_DATABASE_URL is empty", () => {
      process.env = { ...originalEnv, THREADBASE_DATABASE_URL: "" };
      expect(isDbEnabled()).toBe(false);
    });

    it("returns true when THREADBASE_DATABASE_URL is set", () => {
      process.env = {
        ...originalEnv,
        THREADBASE_DATABASE_URL: "postgresql://localhost:5432/threadbase",
      };
      expect(isDbEnabled()).toBe(true);
    });
  });

  describe("getDbConfig", () => {
    it("returns null when DB is not enabled", () => {
      process.env = { ...originalEnv };
      delete process.env.THREADBASE_DATABASE_URL;
      expect(getDbConfig()).toBeNull();
    });

    it("returns config with connection string and defaults", () => {
      process.env = {
        ...originalEnv,
        THREADBASE_DATABASE_URL: "postgresql://user:pass@localhost:5432/threadbase",
      };
      const config = getDbConfig();
      expect(config).not.toBeNull();
      expect(config?.connectionString).toBe("postgresql://user:pass@localhost:5432/threadbase");
      expect(config?.max).toBe(10);
      expect(config?.statementTimeout).toBeUndefined();
    });

    it("reads optional env vars", () => {
      process.env = {
        ...originalEnv,
        THREADBASE_DATABASE_URL: "postgresql://localhost:5432/threadbase",
        THREADBASE_DATABASE_POOL_MAX: "5",
        THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS: "3000",
        THREADBASE_DATABASE_SSL: "require",
      };
      const config = getDbConfig();
      expect(config?.max).toBe(5);
      expect(config?.statementTimeout).toBe(3000);
      expect(config?.ssl).toBe("require");
    });

    it("ignores non-numeric pool max", () => {
      process.env = {
        ...originalEnv,
        THREADBASE_DATABASE_URL: "postgresql://localhost:5432/threadbase",
        THREADBASE_DATABASE_POOL_MAX: "abc",
      };
      const config = getDbConfig();
      expect(config?.max).toBe(10);
    });
  });
});
