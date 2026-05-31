import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMarker, readMarker, writeMarker } from "../../src/lifecycle/marker";
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

describe("marker I/O", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marker-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("returns null when no marker exists", () => {
    expect(readMarker()).toBeNull();
  });

  it("round-trips a marker", () => {
    const m = {
      devPid: 12345,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1 as const,
    };
    writeMarker(m);
    expect(readMarker()).toEqual(m);
  });

  it("clearMarker removes the file", () => {
    writeMarker({
      devPid: 1,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1,
    });
    clearMarker();
    expect(readMarker()).toBeNull();
  });

  it("readMarker returns null and logs on malformed JSON (does not throw)", () => {
    writeFileSync(join(dir, "prod-suspended.json"), "{not json");
    expect(readMarker()).toBeNull();
  });

  it("writeMarker is atomic — uses tmp + rename", () => {
    writeMarker({
      devPid: 1,
      port: 8766,
      repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1,
    });
    const entries = readdirSync(dir);
    expect(entries.filter((e: string) => e.endsWith(".tmp"))).toEqual([]);
  });
});
