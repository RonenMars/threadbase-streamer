// src/agent/dedupe.ts
//
// Bounded LRU for per-session progress-event dedupe. Implementation uses the
// fact that Map iterates in insertion order — re-inserting a key moves it to
// the end, which is exactly LRU semantics with no extra bookkeeping.
//
// Spec §7.1: this is the milestone-B dedupe. The map lives on the session
// record and dies with the session. Postgres-backed durability is option D,
// deferred — see tb-multi-agent docs/plans/postgres-dedupe.md.

export interface ProgressDedupeLRU {
	hasSeen(eventId: string): boolean;
	readonly size: number;
}

export function createProgressDedupeLRU(capacity: number): ProgressDedupeLRU {
	if (!Number.isFinite(capacity) || capacity < 1) {
		throw new Error(`dedupe LRU capacity must be >= 1, got ${capacity}`);
	}
	const map = new Map<string, true>();

	return {
		hasSeen(eventId: string): boolean {
			if (map.has(eventId)) {
				// Refresh recency: remove + reinsert moves to most-recent position.
				map.delete(eventId);
				map.set(eventId, true);
				return true;
			}
			map.set(eventId, true);
			if (map.size > capacity) {
				// Evict the oldest entry (the first key in insertion order).
				const oldest = map.keys().next().value;
				if (oldest !== undefined) map.delete(oldest);
			}
			return false;
		},
		get size(): number {
			return map.size;
		},
	};
}
