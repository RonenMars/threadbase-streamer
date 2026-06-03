// __tests__/agent/dedupe.test.ts
import { describe, expect, it } from "vitest";
import {
	createProgressDedupeLRU,
	type ProgressDedupeLRU,
} from "../../src/agent/dedupe";

describe("ProgressDedupeLRU", () => {
	it("returns false the first time an id is seen, true thereafter", () => {
		const lru: ProgressDedupeLRU = createProgressDedupeLRU(8);
		expect(lru.hasSeen("evt-1")).toBe(false);
		expect(lru.hasSeen("evt-1")).toBe(true);
	});

	it("treats different ids independently", () => {
		const lru = createProgressDedupeLRU(8);
		expect(lru.hasSeen("evt-A")).toBe(false);
		expect(lru.hasSeen("evt-B")).toBe(false);
		expect(lru.hasSeen("evt-A")).toBe(true);
		expect(lru.hasSeen("evt-B")).toBe(true);
	});

	it("evicts oldest ids once capacity is exceeded", () => {
		const lru = createProgressDedupeLRU(4);
		expect(lru.hasSeen("a")).toBe(false);
		expect(lru.hasSeen("b")).toBe(false);
		expect(lru.hasSeen("c")).toBe(false);
		expect(lru.hasSeen("d")).toBe(false);
		expect(lru.hasSeen("e")).toBe(false); // evicts "a"
		// "a" was evicted; first sighting again returns false.
		// (Re-inserting "a" now evicts "b" — verify "b" is gone.)
		// Check "c", "d", "e" still remembered before re-adding "a".
		expect(lru.hasSeen("c")).toBe(true);
		expect(lru.hasSeen("d")).toBe(true);
		expect(lru.hasSeen("e")).toBe(true);
		expect(lru.hasSeen("a")).toBe(false);
	});

	it("treats a re-seen id as a hit AND refreshes its recency", () => {
		const lru = createProgressDedupeLRU(3);
		lru.hasSeen("a"); // false
		lru.hasSeen("b"); // false
		lru.hasSeen("c"); // false
		expect(lru.hasSeen("a")).toBe(true); // refreshes a's recency
		lru.hasSeen("d"); // evicts the now-oldest, which is "b"
		expect(lru.hasSeen("b")).toBe(false); // "b" evicted, fresh sighting
		expect(lru.hasSeen("a")).toBe(true); // still cached
	});

	it("reports its current size", () => {
		const lru = createProgressDedupeLRU(4);
		expect(lru.size).toBe(0);
		lru.hasSeen("a");
		lru.hasSeen("b");
		expect(lru.size).toBe(2);
		lru.hasSeen("a"); // dup — size unchanged
		expect(lru.size).toBe(2);
	});

	it("throws on capacity < 1", () => {
		expect(() => createProgressDedupeLRU(0)).toThrow();
		expect(() => createProgressDedupeLRU(-3)).toThrow();
	});
});
