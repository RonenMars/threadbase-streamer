import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "../src/utils/debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses rapid calls into a single trailing invocation", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d();
    d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses the last call's arguments", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("a");
    d("b");
    d("c");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("fires again for a fresh burst after the wait elapses", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    vi.advanceTimersByTime(100);
    d();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel() suppresses a pending invocation", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("flush() runs a pending invocation immediately", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("x");
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("x");
    // The timer was cleared, so advancing does not fire again.
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush() with nothing pending is a no-op", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});
