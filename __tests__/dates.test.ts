import { describe, expect, it } from "vitest";
import { compareIsoDesc, parseIsoDateOrNull } from "../src/utils/dates";

describe("parseIsoDateOrNull", () => {
  it("returns null for null/undefined/empty", () => {
    expect(parseIsoDateOrNull(null)).toBeNull();
    expect(parseIsoDateOrNull(undefined)).toBeNull();
    expect(parseIsoDateOrNull("")).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(parseIsoDateOrNull("not a date")).toBeNull();
  });

  it("parses a valid ISO timestamp", () => {
    const d = parseIsoDateOrNull("2024-01-01T00:00:00.000Z");
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("compareIsoDesc", () => {
  it("sorts more-recent first", () => {
    const arr = [
      "2024-01-01T00:00:00.000Z",
      "2024-06-01T00:00:00.000Z",
      "2024-03-01T00:00:00.000Z",
    ];
    arr.sort(compareIsoDesc);
    expect(arr[0]).toBe("2024-06-01T00:00:00.000Z");
    expect(arr[2]).toBe("2024-01-01T00:00:00.000Z");
  });

  it("places nulls last regardless", () => {
    const arr = [null, "2024-06-01T00:00:00.000Z", null];
    arr.sort(compareIsoDesc);
    expect(arr[0]).toBe("2024-06-01T00:00:00.000Z");
    expect(arr[1]).toBeNull();
    expect(arr[2]).toBeNull();
  });
});
