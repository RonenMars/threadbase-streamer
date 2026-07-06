import { describe, expect, it } from "vitest";
import {
  permissionAnswerKeys,
  sanitizeAnswerKeys,
} from "../src/services/questions/permissionAnswerKeys";

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

describe("sanitizeAnswerKeys (M5 keystroke-injection guard)", () => {
  it("passes through the safe answer keystrokes verbatim", () => {
    expect(sanitizeAnswerKeys("\r")).toBe("\r"); // bare Enter (press-enter gate)
    expect(sanitizeAnswerKeys("y\r")).toBe("y\r");
    expect(sanitizeAnswerKeys("n\r")).toBe("n\r");
    expect(sanitizeAnswerKeys("\x03")).toBe("\x03"); // Ctrl-C (cancel)
    expect(sanitizeAnswerKeys("2\r")).toBe("2\r"); // single-digit option
    expect(sanitizeAnswerKeys("13\r")).toBe("13\r"); // multi-digit option
  });

  it("returns undefined for undefined input (no field to forward)", () => {
    expect(sanitizeAnswerKeys(undefined)).toBeUndefined();
  });

  it("drops anything outside the allowlist", () => {
    // Shell escapes, control sequences, extra bytes, uppercase, or trailing junk
    // must never be forwarded verbatim to the PTY.
    expect(sanitizeAnswerKeys("rm -rf /\r")).toBeUndefined();
    expect(sanitizeAnswerKeys("y")).toBeUndefined(); // missing Enter
    expect(sanitizeAnswerKeys("yes\r")).toBeUndefined();
    expect(sanitizeAnswerKeys("Y\r")).toBeUndefined(); // uppercase not allowed
    expect(sanitizeAnswerKeys("2\ry\r")).toBeUndefined(); // two answers chained
    expect(sanitizeAnswerKeys("\x1b[A")).toBeUndefined(); // arrow-key escape
    expect(sanitizeAnswerKeys("")).toBeUndefined();
    expect(sanitizeAnswerKeys("2\n")).toBeUndefined(); // newline, not CR
  });
});
