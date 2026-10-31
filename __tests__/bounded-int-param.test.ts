import { boundedIntParam } from "../src/api/handlers/http-helpers";

const u = (qs: string) => new URL(`http://x/?${qs}`);

describe("boundedIntParam", () => {
  it("returns the default when absent or not a number", () => {
    expect(boundedIntParam(u(""), "limit", 50, 1, 500)).toBe(50);
    expect(boundedIntParam(u("limit=abc"), "limit", 50, 1, 500)).toBe(50);
  });
  it("passes an in-range value through", () => {
    expect(boundedIntParam(u("limit=200"), "limit", 50, 1, 500)).toBe(200);
  });
  it("clamps above the max and below the min", () => {
    expect(boundedIntParam(u("limit=100000"), "limit", 50, 1, 500)).toBe(500);
    expect(boundedIntParam(u("limit=-1"), "limit", 50, 1, 500)).toBe(1);
    expect(boundedIntParam(u("offset=-5"), "offset", 0, 0, Number.MAX_SAFE_INTEGER)).toBe(0);
  });
});
