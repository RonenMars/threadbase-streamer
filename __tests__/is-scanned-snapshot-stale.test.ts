import { isScannedSnapshotStale } from "../src/utils/isScannedSnapshotStale";

describe("isScannedSnapshotStale", () => {
  const snapshot = "2026-06-05T08:47:30.000Z";
  const snapshotMs = new Date(snapshot).getTime();

  it("is stale when the file mtime is well past the snapshot timestamp", () => {
    // The real bug: cache/list shows June 7 but the scanner snapshot is frozen
    // at June 5. A file touched two days later must be considered stale.
    const twoDaysLater = snapshotMs + 2 * 24 * 60 * 60 * 1000;
    expect(isScannedSnapshotStale(snapshot, twoDaysLater)).toBe(true);
  });

  it("is not stale when the file mtime matches the snapshot", () => {
    expect(isScannedSnapshotStale(snapshot, snapshotMs)).toBe(false);
  });

  it("tolerates sub-second skew so a fresh snapshot does not churn the index", () => {
    expect(isScannedSnapshotStale(snapshot, snapshotMs + 500)).toBe(false);
  });

  it("is stale once the file is more than the tolerance window newer", () => {
    expect(isScannedSnapshotStale(snapshot, snapshotMs + 1500)).toBe(true);
  });

  it("is not stale when the file is older than the snapshot", () => {
    expect(isScannedSnapshotStale(snapshot, snapshotMs - 5000)).toBe(false);
  });

  it("returns false when mtime is null (stat failed — do not re-scan)", () => {
    expect(isScannedSnapshotStale(snapshot, null)).toBe(false);
  });

  it("returns false when the snapshot timestamp is missing or unparseable", () => {
    expect(isScannedSnapshotStale(null, snapshotMs + 999999)).toBe(false);
    expect(isScannedSnapshotStale(undefined, snapshotMs + 999999)).toBe(false);
    expect(isScannedSnapshotStale("not-a-date", snapshotMs + 999999)).toBe(false);
  });
});
