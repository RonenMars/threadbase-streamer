import { describe, expect, it } from "vitest";
import { MarkerSchema } from "../../src/lifecycle/marker-schema";

describe("MarkerSchema", () => {
  it("accepts a valid marker", () => {
    const valid = {
      devPid: 12345,
      port: 8766,
      repoToplevel: "/Users/me/work/tb-mobile",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1,
    };
    expect(() => MarkerSchema.parse(valid)).not.toThrow();
  });

  it("rejects missing fields", () => {
    expect(() => MarkerSchema.parse({ devPid: 1 })).toThrow();
  });

  it("rejects shimVersion other than 1", () => {
    const m = {
      devPid: 1,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 2,
    };
    expect(() => MarkerSchema.parse(m)).toThrow();
  });
});
