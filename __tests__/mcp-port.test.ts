import { resolvePort } from "../cli/mcp";

describe("tb-streamer mcp port resolution", () => {
  it("falls back to 8766 when THREADBASE_PORT is empty, and takes the flag over the env", () => {
    expect(resolvePort(undefined, "")).toBe(8766);
    expect(resolvePort(undefined, undefined)).toBe(8766);
    expect(resolvePort(undefined, "9000")).toBe(9000);
    expect(resolvePort("9001", "9000")).toBe(9001);
  });

  it("rejects a non-integer or out-of-range port with a one-line message", () => {
    for (const bad of ["abc", "80x", "1.5", "0", "65536", "-1", ""]) {
      expect(() => resolvePort(bad, undefined), bad).toThrow(
        /^Invalid port "[^\n]*": expected an integer between 1 and 65535\.$/,
      );
    }
    expect(() => resolvePort(undefined, "nope")).toThrow(/Invalid port "nope"/);
  });
});
