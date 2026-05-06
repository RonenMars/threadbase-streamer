import { describe, expect, it } from "vitest";
import { canonicalizeProjectPath } from "../src/utils/canonicalizeProjectPath";

describe("canonicalizeProjectPath", () => {
  it("trims leading/trailing whitespace", () => {
    expect(canonicalizeProjectPath("  /a/b  ")).toBe("/a/b");
  });

  it("removes a single trailing forward slash", () => {
    expect(canonicalizeProjectPath("/a/b/")).toBe("/a/b");
  });

  it("removes multiple trailing slashes", () => {
    expect(canonicalizeProjectPath("/a/b///")).toBe("/a/b");
  });

  it("removes trailing backslashes for Windows paths", () => {
    expect(canonicalizeProjectPath("C:\\Users\\me\\proj\\")).toBe("C:\\Users\\me\\proj");
  });

  it("preserves case (does not lowercase)", () => {
    expect(canonicalizeProjectPath("/A/B")).toBe("/A/B");
  });

  it("returns empty string for empty input", () => {
    expect(canonicalizeProjectPath("")).toBe("");
  });
});
