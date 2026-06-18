/**
 * The scanner fires onProgress once per file, so a large scan would otherwise
 * broadcast thousands of scan_progress WebSocket frames. This throttle collapses
 * them to at most one per whole-percent step, plus a guaranteed final frame when
 * the scan completes (scanned === total). Caps frames at ~101 regardless of the
 * file count, while always delivering the terminal 100% update.
 *
 * Returns a predicate: call it with each (scanned, total) tick; it returns true
 * when that tick should be broadcast. Stateful — create one per scan.
 */
export function createScanProgressThrottle(): (scanned: number, total: number) => boolean {
  let lastPercent = -1;
  return (scanned: number, total: number): boolean => {
    // total === 0 (empty scan): emit once so clients see a terminal tick.
    if (total <= 0) {
      if (lastPercent === 100) return false;
      lastPercent = 100;
      return true;
    }
    const isFinal = scanned >= total;
    const percent = Math.floor((scanned / total) * 100);
    if (isFinal) {
      // Always let the final tick through, even if its percent already fired.
      lastPercent = 100;
      return true;
    }
    if (percent === lastPercent) return false;
    lastPercent = percent;
    return true;
  };
}
