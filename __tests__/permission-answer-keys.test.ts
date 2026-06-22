import { describe, expect, it } from "vitest";
import { permissionAnswerKeys } from "../src/services/questions/permissionAnswerKeys";

describe("permissionAnswerKeys", () => {
  it("sends the shown number + Enter (NOT a 1-based down-arrow count)", () => {
    // A gate showing "2. Yes / 3. No": answering "Yes" sends "2\r", not one down.
    expect(permissionAnswerKeys(2)).toBe("2\r");
    expect(permissionAnswerKeys(3)).toBe("3\r");
    expect(permissionAnswerKeys(1)).toBe("1\r");
  });

  it("rejects a non-integer / negative index", () => {
    expect(() => permissionAnswerKeys(-1)).toThrow();
    expect(() => permissionAnswerKeys(1.5)).toThrow();
  });
});
