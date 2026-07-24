import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  type BackupArchive,
  BackupError,
  type BackupProject,
  planRestore,
  remapPaths,
  validateArchive,
} from "../src/services/backup/backup";

/**
 * Metadata export and restore (C9).
 *
 * Project ids are the thing that cannot be reconstructed: a fresh scan invents
 * new ones, breaking every deep link and per-project setting that referenced
 * the old ones. Everything else in the cache regenerates from provider history.
 */

const project = (over: Partial<BackupProject> = {}): BackupProject => ({
  id: "p-1",
  path: "/home/a/repo",
  name: "repo",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const archive = (over: Partial<BackupArchive> = {}): BackupArchive => ({
  manifest: {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: "2026-07-24T00:00:00.000Z",
    streamerVersion: "1.0.0",
    sourceHost: "host-a",
    includesSecrets: false,
    counts: { projects: 1 },
  },
  projects: [project()],
  ...over,
});

describe("validateArchive", () => {
  it("accepts a well-formed archive", () => {
    expect(validateArchive(archive()).projects).toHaveLength(1);
  });

  it.each([
    ["not an object", "nonsense"],
    ["null", null],
    ["no manifest", { projects: [] }],
    ["no projects array", { manifest: archive().manifest }],
  ])("rejects a malformed archive (%s)", (_name, input) => {
    expect(() => validateArchive(input)).toThrow(BackupError);
  });

  // Refuse rather than guess: a future format may mean something different by
  // the same field names, and misreading it corrupts project identity
  // invisibly.
  it("refuses an unsupported format version", () => {
    const a = archive();
    a.manifest.formatVersion = 99;
    expect(() => validateArchive(a)).toThrow(/Unsupported backup format/);
  });

  it("rejects a project with no id or no path", () => {
    expect(() => validateArchive(archive({ projects: [project({ id: "" })] }))).toThrow(/no id/);
    expect(() => validateArchive(archive({ projects: [project({ path: "" })] }))).toThrow(
      /no path/,
    );
  });

  // Duplicate ids would make restore order-dependent — rejected rather than
  // resolved by last-write-wins.
  it("rejects duplicate project ids", () => {
    const dupes = [project({ id: "same" }), project({ id: "same", path: "/other" })];
    expect(() => validateArchive(archive({ projects: dupes }))).toThrow(/duplicate/i);
  });

  // Validation happens before anything is applied, so a bad archive is rejected
  // whole rather than halfway.
  it("reports a code for every rejection", () => {
    try {
      validateArchive("nope");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as BackupError).code).toBe("INVALID_ARCHIVE");
    }
  });
});

describe("remapPaths", () => {
  // Restored onto a different machine, every path points at nothing without
  // remapping and the restore is useless.
  it("rewrites a matching prefix", () => {
    const out = remapPaths(
      [project({ path: "/home/a/repo" })],
      [{ from: "/home/a", to: "/Users/b" }],
    );
    expect(out[0].path).toBe("/Users/b/repo");
  });

  it("leaves unmatched paths untouched rather than mangling them", () => {
    const out = remapPaths(
      [project({ path: "/opt/thing" })],
      [{ from: "/home/a", to: "/Users/b" }],
    );
    expect(out[0].path).toBe("/opt/thing");
  });

  it("prefers the most specific rule", () => {
    const out = remapPaths(
      [project({ path: "/home/a/work/repo" })],
      [
        { from: "/home/a", to: "/x" },
        { from: "/home/a/work", to: "/y" },
      ],
    );
    expect(out[0].path).toBe("/y/repo");
  });

  // A prefix must match a path boundary, not a partial segment: /home/ab is
  // not inside /home/a.
  it("does not match a partial path segment", () => {
    const out = remapPaths([project({ path: "/home/abc" })], [{ from: "/home/ab", to: "/x" }]);
    expect(out[0].path).toBe("/home/abc");
  });

  it("remaps an exact match", () => {
    const out = remapPaths([project({ path: "/home/a" })], [{ from: "/home/a", to: "/Users/b" }]);
    expect(out[0].path).toBe("/Users/b");
  });
});

describe("planRestore", () => {
  it("creates projects that do not exist", () => {
    const plan = planRestore([project({ id: "new" })], []);
    expect(plan.create.map((p) => p.id)).toEqual(["new"]);
  });

  it("leaves an identical project alone", () => {
    const plan = planRestore([project()], [{ id: "p-1", path: "/home/a/repo" }]);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.conflict).toEqual([]);
  });

  // The machine-move case: same project, new location.
  it("updates a known id whose path changed", () => {
    const plan = planRestore(
      [project({ path: "/Users/b/repo" })],
      [{ id: "p-1", path: "/home/a/repo" }],
    );
    expect(plan.update.map((p) => p.path)).toEqual(["/Users/b/repo"]);
  });

  // Applying either id would break whichever links used the other, so this
  // needs an explicit decision rather than a silent winner.
  it("reports a conflict when a path is claimed by a different id", () => {
    const plan = planRestore(
      [project({ id: "incoming" })],
      [{ id: "existing", path: "/home/a/repo" }],
    );
    expect(plan.conflict).toHaveLength(1);
    expect(plan.conflict[0].existingId).toBe("existing");
    expect(plan.create).toEqual([]);
  });

  it("classifies a mixed archive into all three buckets", () => {
    const plan = planRestore(
      [
        project({ id: "a", path: "/p/a" }),
        project({ id: "b", path: "/p/b-moved" }),
        project({ id: "c", path: "/p/taken" }),
      ],
      [
        { id: "b", path: "/p/b" },
        { id: "other", path: "/p/taken" },
      ],
    );

    expect(plan.create.map((p) => p.id)).toEqual(["a"]);
    expect(plan.update.map((p) => p.id)).toEqual(["b"]);
    expect(plan.conflict.map((c) => c.incoming.id)).toEqual(["c"]);
  });
});
