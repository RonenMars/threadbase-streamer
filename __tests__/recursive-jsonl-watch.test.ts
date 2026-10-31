import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchJsonlRecursively } from "../src/services/conversations/recursiveJsonlWatch";

const SETTLE = 400;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond` holds: FSEvents delivery latency is unbounded on a loaded box. */
async function until(cond: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(25);
}

describe("watchJsonlRecursively", () => {
  let dir: string;
  let fired: string[];
  let watch: ReturnType<typeof watchJsonlRecursively>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tb-recursive-watch-"));
    fired = [];
    watch = watchJsonlRecursively(
      dir,
      (f) => fired.push(f),
      () => {},
      SETTLE,
    );
    // The FSEvents stream starts asynchronously and drops writes made before it
    // is up, so write probes until one is reported, then start from a clean slate.
    const probe = join(dir, "arm.jsonl");
    // Probes are spaced past the settle window, or each one resets the debounce.
    for (let i = 0; fired.length === 0 && i < 20; i++) {
      writeFileSync(probe, String(i));
      await wait(SETTLE * 2);
    }
    await wait(SETTLE * 2);
    rmSync(probe);
    await wait(SETTLE * 3);
    fired.length = 0;
  });
  afterEach(() => {
    watch.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a .jsonl created in a nested directory, once, with its full path", async () => {
    mkdirSync(join(dir, "proj", "subagents"), { recursive: true });
    const file = join(dir, "proj", "subagents", "a.jsonl");
    writeFileSync(file, "{}\n");
    await wait(SETTLE / 4); // separate events inside one settle window
    appendFileSync(file, "{}\n");
    await wait(SETTLE / 4);
    appendFileSync(file, "{}\n");
    await until(() => fired.length > 0);
    await wait(SETTLE * 3);
    expect(fired).toEqual([file]);
  });

  it("ignores files that are not .jsonl", async () => {
    writeFileSync(join(dir, "note.md"), "x");
    writeFileSync(join(dir, "custom-title.json"), "x");
    const sentinel = join(dir, "sentinel.jsonl"); // positive control, written last
    writeFileSync(sentinel, "{}\n");
    await until(() => fired.length > 0);
    await wait(SETTLE * 4);
    expect(fired).toEqual([sentinel]);
  });

  it("reports a deletion", async () => {
    const file = join(dir, "gone.jsonl");
    writeFileSync(file, "{}\n");
    await until(() => fired.length > 0);
    await wait(SETTLE * 4);
    fired.length = 0;
    rmSync(file);
    await until(() => fired.length > 0);
    expect(fired).toEqual([file]);
  });

  it("close() cancels a report already waiting out its settle window", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    writeFileSync(join(dir, "late.jsonl"), "{}\n");
    await until(() => timers.mock.calls.some((c) => c[1] === SETTLE)); // settle timer is pending
    const pending = timers.mock.calls.some((c) => c[1] === SETTLE);
    watch.close();
    timers.mockRestore();
    expect(pending).toBe(true);
    await wait(SETTLE * 3);
    expect(fired).toEqual([]);
  });

  it("detach() silences events and a late error without closing", async () => {
    const mine: string[] = [];
    const w = watchJsonlRecursively(dir, (f) => mine.push(f), vi.fn(), SETTLE);
    w.detach();
    writeFileSync(join(dir, "after.jsonl"), "{}\n");
    await until(() => fired.length > 0); // the attached watch still fires
    await wait(SETTLE * 4);
    expect(mine).toEqual([]);
    expect(fired).toHaveLength(1);
    w.close();
  });
});
