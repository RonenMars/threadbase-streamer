import { resolveAllowedOrigins } from "../src/api/middleware/cors.middleware";

describe("resolveAllowedOrigins", () => {
  it("returns null (CORS off) when unset or falsy", () => {
    for (const v of [undefined, "", "  ", "0", "false", "no", "off", "FALSE"]) {
      expect(resolveAllowedOrigins(v)).toBeNull();
    }
  });

  it("enables the localhost dev defaults for on/off tokens", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      const origins = resolveAllowedOrigins(v);
      expect(origins?.has("http://localhost:8081")).toBe(true);
      expect(origins?.has("https://app.example.com")).toBe(false);
    }
  });

  it("adds explicit origins on top of the dev defaults", () => {
    const origins = resolveAllowedOrigins("https://app.example.com, https://admin.example.com");
    expect(origins?.has("http://localhost:8081")).toBe(true);
    expect(origins?.has("https://app.example.com")).toBe(true);
    expect(origins?.has("https://admin.example.com")).toBe(true);
  });
});
