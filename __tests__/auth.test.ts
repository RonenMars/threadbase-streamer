// We test the pure functions directly; loadOrCreateApiKey uses a fixed path
// so we test generateApiKey and validateApiKey here.
import { generateApiKey, validateApiKey } from "../src/auth";

describe("auth", () => {
  describe("generateApiKey", () => {
    it("returns a key with tb_ prefix", () => {
      const key = generateApiKey();
      expect(key).toMatch(/^tb_[a-f0-9]{32}$/);
    });

    it("generates unique keys", () => {
      const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
      expect(keys.size).toBe(100);
    });
  });

  describe("validateApiKey", () => {
    it("returns true for matching keys", () => {
      const key = generateApiKey();
      expect(validateApiKey(key, key)).toBe(true);
    });

    it("returns false for different keys", () => {
      const a = generateApiKey();
      const b = generateApiKey();
      expect(validateApiKey(a, b)).toBe(false);
    });

    it("returns false for different lengths", () => {
      expect(validateApiKey("short", "tb_abcdef1234567890abcdef1234567890")).toBe(false);
    });

    it("returns false for empty strings", () => {
      expect(validateApiKey("", "tb_abc")).toBe(false);
    });
  });
});
