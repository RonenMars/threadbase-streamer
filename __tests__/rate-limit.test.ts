import { createRateBudget } from "../src/api/rate-limit";

describe("createRateBudget retryAfterSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("counts down to when the oldest hit that holds the key over the limit ages out", () => {
    const budget = createRateBudget({ limit: 2, windowMs: 60_000 });
    budget.charge("k");
    vi.advanceTimersByTime(20_000);
    budget.charge("k");
    expect(budget.check("k")).toBe(false);
    expect(budget.retryAfterSeconds("k")).toBe(40);

    vi.advanceTimersByTime(10_500);
    expect(budget.retryAfterSeconds("k")).toBe(30);

    vi.advanceTimersByTime(30_000);
    expect(budget.check("k")).toBe(true);
  });
});
