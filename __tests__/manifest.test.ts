import { describe, expect, it } from "vitest";
import { pickArtifact, platformKey, ReleaseManifestSchema } from "../src/updater/manifest";

describe("ReleaseManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const m = ReleaseManifestSchema.parse({
      version: "1.2.3",
      schemaVersion: 1,
      artifacts: {
        "darwin-arm64": {
          filename: "x.tgz",
          sha256: "a".repeat(64),
          size: 1024,
        },
      },
    });
    expect(m.version).toBe("1.2.3");
  });

  it("rejects malformed sha256", () => {
    expect(() =>
      ReleaseManifestSchema.parse({
        version: "1.2.3",
        schemaVersion: 1,
        artifacts: {
          "darwin-arm64": { filename: "x.tgz", sha256: "not-hex", size: 1024 },
        },
      }),
    ).toThrow();
  });

  it("rejects negative size", () => {
    expect(() =>
      ReleaseManifestSchema.parse({
        version: "1.2.3",
        schemaVersion: 1,
        artifacts: {
          "darwin-arm64": { filename: "x.tgz", sha256: "a".repeat(64), size: -1 },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(() =>
      ReleaseManifestSchema.parse({
        version: "1.2.3",
        schemaVersion: 1,
        artifacts: {},
        extra: "no",
      }),
    ).toThrow();
  });
});

describe("pickArtifact", () => {
  it("returns the artifact for the current platform when present", () => {
    const manifest = ReleaseManifestSchema.parse({
      version: "1.2.3",
      schemaVersion: 1,
      artifacts: {
        [platformKey()]: { filename: "match.tgz", sha256: "b".repeat(64), size: 1 },
        "other-arch": { filename: "other.tgz", sha256: "c".repeat(64), size: 2 },
      },
    });
    expect(pickArtifact(manifest).filename).toBe("match.tgz");
  });

  it("throws when the current platform has no artifact", () => {
    const manifest = ReleaseManifestSchema.parse({
      version: "1.2.3",
      schemaVersion: 1,
      artifacts: {
        "imaginary-arch": { filename: "x.tgz", sha256: "d".repeat(64), size: 1 },
      },
    });
    expect(() => pickArtifact(manifest)).toThrow(/No artifact/);
  });
});
