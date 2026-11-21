import { createSubagentCountNotifier } from "../src/services/conversations/subagentCountNotifier";

describe("createSubagentCountNotifier", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (initial = 0) => {
    const counts = new Map<string, number>([["p1", initial]]);
    const broadcast = vi.fn();
    const n = createSubagentCountNotifier({
      count: (id) => counts.get(id) ?? 0,
      broadcast,
      debounceMs: 100,
    });
    return { counts, broadcast, n };
  };

  it("folds a burst of pokes into one frame carrying the full total", () => {
    const { counts, broadcast, n } = setup();
    counts.set("p1", 3);
    n.poke("p1");
    n.poke("p1");
    n.poke("p1");
    expect(broadcast).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: "subagents_changed",
      parentId: "p1",
      total: 3,
    });
  });

  it("stays quiet when the re-read count is unchanged", () => {
    const { counts, broadcast, n } = setup();
    counts.set("p1", 2);
    n.poke("p1");
    vi.advanceTimersByTime(100);
    n.poke("p1"); // scanner re-upserted the same children
    vi.advanceTimersByTime(100);
    expect(broadcast).toHaveBeenCalledTimes(1);
    counts.set("p1", 3);
    n.poke("p1");
    vi.advanceTimersByTime(100);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].total).toBe(3);
  });

  it("dispose drops pending pokes", () => {
    const { counts, broadcast, n } = setup();
    counts.set("p1", 1);
    n.poke("p1");
    n.dispose();
    vi.advanceTimersByTime(1000);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
