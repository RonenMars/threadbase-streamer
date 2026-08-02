import { describe, expect, it } from "vitest";
import { deriveSessionName } from "../src/utils/deriveSessionName";

describe("deriveSessionName", () => {
  it("takes the first line, trimmed", () => {
    expect(deriveSessionName("fix the bug\nmore context below")).toBe("fix the bug");
  });

  it("truncates to 80 characters", () => {
    const long = "x".repeat(200);
    expect(deriveSessionName(long)).toHaveLength(80);
  });

  it("trims surrounding whitespace on the first line", () => {
    expect(deriveSessionName("   spaced out   \nrest")).toBe("spaced out");
  });

  it("returns an empty string for blank input", () => {
    expect(deriveSessionName("")).toBe("");
    expect(deriveSessionName("\nsecond line")).toBe("");
  });
});
