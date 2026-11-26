import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationReadsRepository } from "../src/db/repositories/conversation-reads.repository";
import { RuntimeStore } from "../src/db/runtime-store";

let dir: string;
let store: RuntimeStore;
let repo: ConversationReadsRepository;

const msg = (key: string, ts: number) => ({ key, ts });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-reads-"));
  store = RuntimeStore.open(join(dir, "runtime.db"));
  repo = new ConversationReadsRepository(store.getDatabase());
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration 012", () => {
  it("records one baseline at upgrade time, and reopening leaves it unchanged", () => {
    const first = repo.baseline();
    expect(first).toBeGreaterThan(Date.now() - 60_000);
    expect(first).toBeLessThanOrEqual(Date.now());
    store.close();
    store = RuntimeStore.open(join(dir, "runtime.db"));
    expect(new ConversationReadsRepository(store.getDatabase()).baseline()).toBe(first);
  });
});

describe("frontiers", () => {
  it("returns the baseline for an id with no row (positive control: a row wins)", () => {
    const base = repo.baseline();
    repo.recordAcks("c1", [msg("a", base + 10)], "dev");
    repo.advance("c1", [msg("a", base + 10)]);
    const f = repo.frontiers(["c1", "c2"]);
    expect(f.get("c1")).toBe(base + 10);
    expect(f.get("c2")).toBe(base);
  });
});

describe("recordAcks", () => {
  it("returns only the keys that were new, and the first read_at never moves", () => {
    const first = repo.recordAcks("c1", [msg("a", 1), msg("b", 2)], "dev-1");
    expect(first.map((r) => r.key)).toEqual(["a", "b"]);
    const readAt = repo.acksFor("c1", ["a", "b"]);
    expect(readAt.size).toBe(2);

    const second = repo.recordAcks("c1", [msg("b", 2), msg("c", 3)], "dev-2");
    expect(second.map((r) => r.key)).toEqual(["c"]);
    expect(repo.acksFor("c1", ["a", "b"])).toEqual(readAt);
  });

  it("keeps conversations apart", () => {
    repo.recordAcks("c1", [msg("a", 1)], null);
    expect(repo.acksFor("c2", ["a"]).size).toBe(0);
  });
});

describe("advance", () => {
  it("walks the unbroken acked prefix and stops at the first gap", () => {
    const base = repo.baseline();
    const all = [
      msg("m1", base + 1),
      msg("m2", base + 2),
      msg("m3", base + 3),
      msg("m4", base + 4),
    ];
    repo.recordAcks("c1", [all[0], all[1], all[3]], null); // m3 skipped
    expect(repo.advance("c1", all)).toBe(base + 2);
    repo.recordAcks("c1", [all[2]], null);
    expect(repo.advance("c1", all)).toBe(base + 4);
  });

  it("never moves backward", () => {
    const base = repo.baseline();
    repo.recordAcks("c1", [msg("a", base + 5)], null);
    expect(repo.advance("c1", [msg("a", base + 5)])).toBe(base + 5);
    // A later call that sees only an older acked message must not pull it back.
    repo.recordAcks("c1", [msg("old", base + 1)], null);
    expect(repo.advance("c1", [msg("old", base + 1)])).toBe(base + 5);
  });

  it("does not step over a message that shares a timestamp with an unacked one", () => {
    const base = repo.baseline();
    const a = msg("a", base + 7);
    const b = msg("b", base + 7);
    repo.recordAcks("c1", [a], null);
    expect(repo.advance("c1", [a, b])).toBe(base); // frontier unchanged
    repo.recordAcks("c1", [b], null);
    expect(repo.advance("c1", [a, b])).toBe(base + 7);
  });

  it("returns the baseline and writes nothing when nothing is acked", () => {
    const base = repo.baseline();
    expect(repo.advance("c1", [msg("a", base + 1)])).toBe(base);
    expect(repo.frontiers(["c1"]).get("c1")).toBe(base);
  });
});
