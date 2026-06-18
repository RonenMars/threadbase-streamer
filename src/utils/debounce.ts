/**
 * Trailing-edge debounce: collapses calls that arrive within `waitMs` of each
 * other into a single invocation, scheduled `waitMs` after the most recent
 * call. The last call's arguments win.
 *
 * The returned function carries two extra methods:
 *   - cancel(): drop any pending invocation (use on shutdown so a timer
 *     doesn't keep the process alive).
 *   - flush():  run any pending invocation immediately (useful in tests).
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const run = () => {
    timer = null;
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };

  const debounced = (...args: A): void => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, waitMs);
  };

  debounced.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  debounced.flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };

  return debounced;
}
