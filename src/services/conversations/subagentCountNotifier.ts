import type { WSMessage } from "../../types";

/** Trailing window that folds a burst of child writes (8 children at spawn) into one count. */
export const SUBAGENT_COUNT_DEBOUNCE_MS = 400;

/**
 * Tells clients when a parent's sub-agent count changes, so the "Sub-agents (n)"
 * header can move without polling. A poke is only a hint that a child row was
 * written: the count is re-read from the cache and sent only when it differs
 * from the last one sent, because the scanner re-upserts unchanged children on
 * every reconcile. The frame always carries the full `total`, never a delta, so
 * a client that missed one frame is corrected by the next.
 */
export function createSubagentCountNotifier(deps: {
  count: (parentId: string) => number;
  broadcast: (msg: WSMessage) => void;
  debounceMs?: number;
}): { poke: (parentId: string) => void; dispose: () => void } {
  const last = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const flush = (parentId: string) => {
    timers.delete(parentId);
    const total = deps.count(parentId);
    if (last.get(parentId) === total) return;
    last.set(parentId, total);
    deps.broadcast({
      type: "subagents_changed",
      parentId,
      total,
      updatedAt: new Date().toISOString(),
    });
  };

  return {
    poke(parentId) {
      if (timers.has(parentId)) return;
      const t = setTimeout(() => flush(parentId), deps.debounceMs ?? SUBAGENT_COUNT_DEBOUNCE_MS);
      t.unref?.();
      timers.set(parentId, t);
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
