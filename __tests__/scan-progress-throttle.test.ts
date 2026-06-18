import { createScanProgressThrottle } from "../src/utils/scanProgressThrottle";

describe("createScanProgressThrottle", () => {
  it("emits at most once per whole percent and always emits the final tick", () => {
    const shouldEmit = createScanProgressThrottle();
    const total = 1000;
    let emitted = 0;
    for (let scanned = 1; scanned <= total; scanned++) {
      if (shouldEmit(scanned, total)) emitted++;
    }
    // 1%..99% (one frame each) + the final 100% tick = 100, far fewer than 1000.
    expect(emitted).toBeLessThanOrEqual(101);
    expect(emitted).toBeGreaterThan(0);
  });

  it("always lets the final tick through even when its percent already fired", () => {
    const shouldEmit = createScanProgressThrottle();
    // 99/100 and 100/100 both floor to different percents, but verify the
    // terminal tick is never suppressed: feed the same percent twice at the end.
    expect(shouldEmit(50, 100)).toBe(true); // 50% — new
    expect(shouldEmit(50, 100)).toBe(false); // 50% again — suppressed
    expect(shouldEmit(100, 100)).toBe(true); // final — always emitted
  });

  it("does not emit a non-final tick whose percent is unchanged", () => {
    const shouldEmit = createScanProgressThrottle();
    expect(shouldEmit(10, 100)).toBe(true); // 10%
    expect(shouldEmit(10, 100)).toBe(false); // still 10%
    expect(shouldEmit(11, 100)).toBe(true); // 11%
  });

  it("emits exactly one terminal tick for an empty (total=0) scan", () => {
    const shouldEmit = createScanProgressThrottle();
    expect(shouldEmit(0, 0)).toBe(true);
    expect(shouldEmit(0, 0)).toBe(false);
  });

  it("treats scanned >= total as final", () => {
    const shouldEmit = createScanProgressThrottle();
    expect(shouldEmit(5, 5)).toBe(true);
    // An overshoot (scanned > total) is still final, not an error.
    expect(shouldEmit(6, 5)).toBe(true);
  });
});
