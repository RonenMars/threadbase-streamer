import { mkdtempSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getLogger } from "../src/logger";

// `~/.threadbase/logs/stdout.log` reached 261 MB with no rotation of any kind.
// Two fifths of it was the logger writing every call twice — once as pino JSON
// and once as an unstructured `console` line that had no level of its own, so
// it printed `debug` calls pino had already filtered out. These lock in the
// console duplicate being gone under a supervisor, and the boot-time size cap.
//
// The `→ 597` half of that log's problem is fixed and covered separately by
// http-request-log.test.ts, which landed with the query-timing work.

function withIsTTY(value: boolean | undefined, fn: () => void) {
  const original = process.stdout.isTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = value;
  try {
    fn();
  } finally {
    (process.stdout as { isTTY?: boolean }).isTTY = original;
  }
}

describe("logger default destination", () => {
  it("does not duplicate to console when stdout is not a TTY", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    withIsTTY(false, () => {
      getLogger("log-volume-test").info("supervised info line");
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("drops a debug call entirely when not a TTY and pino is at info", () => {
    // The 261 MB log's single loudest line was a debug call that printed
    // 11,570 times in 50k lines because `console` ignored the pino level.
    // Nothing the operator could set turned it off.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    withIsTTY(false, () => {
      getLogger("log-volume-test").debug("Scanner invalidated by directory event: /x.jsonl");
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still prints a readable line at a human terminal", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    withIsTTY(true, () => {
      getLogger("log-volume-test").info("interactive line");
    });
    expect(spy).toHaveBeenCalledWith("interactive line");
    spy.mockRestore();
  });

  it("honours an explicit console dest even under a supervisor", () => {
    // The CLI's user-facing output (banners, QR, `prod doctor`) passes
    // dest="console" deliberately and must survive the default change.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    withIsTTY(false, () => {
      getLogger("log-volume-test").info("API key updated.", undefined, "console");
    });
    expect(spy).toHaveBeenCalledWith("API key updated.");
    spy.mockRestore();
  });

  it("honours an explicit pino dest at a terminal", () => {
    // The query-timing lines pass dest="pino" explicitly. That was a workaround
    // for the old "both" default; it must keep meaning "no console line".
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    withIsTTY(true, () => {
      getLogger("log-volume-test").info("db.query", undefined, "pino");
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("truncateOversizedLogs", () => {
  it("empties a file over the cap and leaves one under it alone", async () => {
    const { truncateOversizedLogs } = await import("../src/lifecycle/log-cap");
    const dir = mkdtempSync(join(tmpdir(), "threadbase-log-cap-"));
    const big = join(dir, "stdout.log");
    const small = join(dir, "stderr.log");
    writeFileSync(big, "x".repeat(2048));
    writeFileSync(small, "y".repeat(16));

    const truncated = truncateOversizedLogs(1024, [big, small]);

    expect(truncated).toEqual([big]);
    // Truncated in place: the inode survives, so the supervisor's held fd stays
    // valid. Renaming or unlinking would leave the daemon writing to a ghost.
    expect(statSync(big).size).toBe(0);
    expect(statSync(small).size).toBe(16);
  });

  it("never throws on a missing or unreadable path", async () => {
    const { truncateOversizedLogs } = await import("../src/lifecycle/log-cap");
    const dir = mkdtempSync(join(tmpdir(), "threadbase-log-cap-"));
    expect(() => truncateOversizedLogs(0, [join(dir, "nope.log")])).not.toThrow();
    expect(truncateOversizedLogs(0, [join(dir, "nope.log")])).toEqual([]);
  });
});
