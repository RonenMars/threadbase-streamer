import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationMeta, ConversationScanner } from "@threadbase-sh/scanner";
import { REFRESH_TTL_MS, ScannerManager } from "../src/scanner-manager";

const FILE = "/tmp/tb-refresh-fixture/rollout.jsonl";

/**
 * A scanner stand-in whose parses are held open by the test, and which records
 * the "disk content" each parse read AT ITS START. That capture is the whole
 * point: it is what makes "an older parse completed" and "a parse observed the
 * write" two different things, which is the race refreshFileAfterWrite closes.
 */
class FakeScanner {
  /** What a parse starting now would read. Bump it to model an append. */
  content = 1;
  /** Resolve with null instead of metadata — the scanner's missing/empty answer. */
  emptyFile = false;
  private concurrent = 0;
  maxConcurrent = 0;
  passes: Array<{
    path: string;
    observed: number;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  refreshFile(filePath: string): Promise<ConversationMeta | null> {
    const observed = this.content;
    const empty = this.emptyFile;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    return new Promise((resolve, reject) => {
      this.passes.push({
        path: filePath,
        observed,
        resolve: () => {
          this.concurrent -= 1;
          resolve(empty ? null : ({ messageCount: observed } as ConversationMeta));
        },
        reject: (err) => {
          this.concurrent -= 1;
          reject(err);
        },
      });
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeManager(): ScannerManager {
  return new ScannerManager({
    scanProfiles: [],
    codexRoots: [],
    directoryDebounceMs: 0,
    persistenceDisabled: true,
    cache: () => null,
    cacheMonitor: () => null,
    projectsRepo: () => null,
    conversationsRepo: () => null,
    cacheMetadataRepo: () => null,
    trackCacheWrite: () => {},
  });
}

/** Give the promise chain a turn without depending on any timer. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ScannerManager refresh coordination", () => {
  let manager: ScannerManager;
  let fake: FakeScanner;
  let scanner: ConversationScanner;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    manager = makeManager();
    fake = new FakeScanner();
    scanner = fake as unknown as ConversationScanner;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("post-write is not satisfied by a parse that started before the write", async () => {
    const read = manager.refreshFileForRead(scanner, FILE);
    expect(fake.passes).toHaveLength(1);

    // The agent appends AFTER that parse captured the file.
    fake.content = 2;
    const write = manager.refreshFileAfterWrite(scanner, FILE);

    // No parallel parse: the scanner single-flights refreshFile internally, so
    // reaching it a second time here would hand the writer the first parse.
    expect(fake.passes).toHaveLength(1);

    fake.passes[0].resolve();
    await expect(read).resolves.toEqual({ outcome: "refreshed", meta: { messageCount: 1 } });

    // The follow-up starts at the predecessor's settle, and reads the append.
    expect(fake.passes).toHaveLength(2);
    expect(fake.passes[1].observed).toBe(2);
    fake.passes[1].resolve();
    await expect(write).resolves.toEqual({ outcome: "refreshed", meta: { messageCount: 2 } });
    expect(fake.maxConcurrent).toBe(1);
  });

  it("notifications arriving before the follow-up starts share one pass", async () => {
    const read = manager.refreshFileForRead(scanner, FILE);
    fake.content = 2;
    const writes = [
      manager.refreshFileAfterWrite(scanner, FILE),
      manager.refreshFileAfterWrite(scanner, FILE),
      manager.refreshFileAfterWrite(scanner, FILE),
    ];
    expect(fake.passes).toHaveLength(1);

    fake.passes[0].resolve();
    await read;
    expect(fake.passes).toHaveLength(2);
    fake.passes[1].resolve();

    expect(await Promise.all(writes)).toEqual([
      { outcome: "refreshed", meta: { messageCount: 2 } },
      { outcome: "joined", meta: { messageCount: 2 } },
      { outcome: "joined", meta: { messageCount: 2 } },
    ]);
    // Three notifications, one extra parse.
    expect(fake.passes).toHaveLength(2);
  });

  it("a notification arriving during the follow-up gets a pass of its own", async () => {
    const first = manager.refreshFileAfterWrite(scanner, FILE);
    fake.content = 2;
    const second = manager.refreshFileAfterWrite(scanner, FILE);

    fake.passes[0].resolve();
    await first;
    // Pass 2 (the follow-up covering `second`) has now STARTED, so a write
    // landing here cannot be covered by it.
    expect(fake.passes).toHaveLength(2);
    fake.content = 3;
    const third = manager.refreshFileAfterWrite(scanner, FILE);
    expect(fake.passes).toHaveLength(2);

    fake.passes[1].resolve();
    await expect(second).resolves.toEqual({ outcome: "refreshed", meta: { messageCount: 2 } });
    expect(fake.passes).toHaveLength(3);
    expect(fake.passes[2].observed).toBe(3);
    fake.passes[2].resolve();
    await expect(third).resolves.toEqual({ outcome: "refreshed", meta: { messageCount: 3 } });
  });

  it("stacked reads stay single-flighted and TTL-throttled while the file changes", async () => {
    const a = manager.refreshFileForRead(scanner, FILE);
    fake.content = 2;
    const b = manager.refreshFileForRead(scanner, FILE);
    expect(fake.passes).toHaveLength(1);
    fake.passes[0].resolve();
    expect(await a).toEqual({ outcome: "refreshed", meta: { messageCount: 1 } });
    expect(await b).toEqual({ outcome: "joined", meta: { messageCount: 1 } });

    // A changed file must NOT punch through the read throttle.
    fake.content = 3;
    vi.advanceTimersByTime(REFRESH_TTL_MS - 1);
    expect(await manager.refreshFileForRead(scanner, FILE)).toEqual({
      outcome: "skipped",
      meta: null,
    });
    expect(fake.passes).toHaveLength(1);

    vi.advanceTimersByTime(1);
    const after = manager.refreshFileForRead(scanner, FILE);
    expect(fake.passes).toHaveLength(2);
    fake.passes[1].resolve();
    expect(await after).toEqual({ outcome: "refreshed", meta: { messageCount: 3 } });
  });

  it("a rejected pass arms nothing and does not swallow the next attempt", async () => {
    const first = manager.refreshFileAfterWrite(scanner, FILE);
    const queued = manager.refreshFileAfterWrite(scanner, FILE);
    fake.passes[0].reject(new Error("parse blew up"));
    await expect(first).rejects.toThrow("parse blew up");

    // The queued work still performs its covering attempt, and rejects
    // clearly rather than resolving as if it had run.
    expect(fake.passes).toHaveLength(2);
    fake.passes[1].reject(new Error("again"));
    await expect(queued).rejects.toThrow("again");
    // Exactly once — a failure must not turn into a retry loop.
    expect(fake.passes).toHaveLength(2);

    // Neither rejection observed the file, so neither arms the read throttle.
    const read = manager.refreshFileForRead(scanner, FILE);
    expect(fake.passes).toHaveLength(3);
    fake.passes[2].resolve();
    expect(await read).toEqual({ outcome: "refreshed", meta: { messageCount: 1 } });
  });

  it("a legitimate null is reported as work performed, not as a skip", async () => {
    fake.emptyFile = true;
    const gone = manager.refreshFileAfterWrite(scanner, FILE);
    fake.passes[0].resolve();
    expect(await gone).toEqual({ outcome: "refreshed", meta: null });

    // Same null meta, different outcome — that is the distinction the log needs.
    expect(await manager.refreshFileForRead(scanner, FILE)).toEqual({
      outcome: "skipped",
      meta: null,
    });
  });

  it("a path alias shares one pass rather than opening a second parse", async () => {
    const read = manager.refreshFileForRead(scanner, FILE);
    fake.content = 2;
    // Same file, different spelling: it must land on the same coordination
    // state, so the writer queues instead of racing a parallel parse.
    const write = manager.refreshFileAfterWrite(scanner, `  ${FILE}  `);
    expect(fake.passes).toHaveLength(1);
    // The scanner still gets the spelling the first caller used.
    expect(fake.passes[0].path).toBe(FILE);

    fake.passes[0].resolve();
    await read;
    fake.passes[1].resolve();
    await expect(write).resolves.toEqual({ outcome: "refreshed", meta: { messageCount: 2 } });
    expect(fake.maxConcurrent).toBe(1);
  });

  it("work on a replaced scanner cannot satisfy a request against its successor", async () => {
    const old = manager.refreshFileForRead(scanner, FILE);
    fake.content = 2;
    const pending = manager.refreshFileAfterWrite(scanner, FILE);

    // rescanForRefresh swapped the instance: the old parse indexes into a
    // scanner nothing reads any more.
    const nextFake = new FakeScanner();
    nextFake.content = 2;
    const next = nextFake as unknown as ConversationScanner;
    const onNew = manager.refreshFileForRead(next, FILE);

    // The owed post-write work was re-armed against the new scanner...
    expect(nextFake.passes).toHaveLength(1);
    // ...and the read joined it rather than opening a second parse.
    expect(await settle(nextFake, onNew)).toEqual({
      outcome: "joined",
      meta: { messageCount: 2 },
    });
    await expect(pending).resolves.toEqual({ outcome: "refreshed", meta: { messageCount: 2 } });

    // The old scanner's parse resolving late must not revive its state.
    fake.passes[0].resolve();
    await expect(old).resolves.toEqual({ outcome: "refreshed", meta: { messageCount: 1 } });
    expect(fake.passes).toHaveLength(1);
    expect(nextFake.passes).toHaveLength(1);
  });

  it("close() waits for outstanding refresh work before tearing scanners down", async () => {
    manager.track(scanner);
    const write = manager.refreshFileAfterWrite(scanner, FILE);
    const queued = manager.refreshFileAfterWrite(scanner, FILE);

    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);

    fake.passes[0].resolve();
    await write;
    await flush();
    expect(closed).toBe(false);

    fake.passes[1].resolve();
    await queued;
    await closing;
    expect(closed).toBe(true);
  });
});

/** Resolve the fake's newest pass, then await the caller's result. */
async function settle<T>(fake: FakeScanner, result: Promise<T>): Promise<T> {
  fake.passes[fake.passes.length - 1].resolve();
  return result;
}

describe("ScannerManager refresh coordination (real scanner)", () => {
  const ID = "9c1f0e2a-1111-4222-8333-444455556666";
  let dir: string;
  let file: string;
  let scanner: ConversationScanner;
  let manager: ScannerManager;

  const turn = (text: string, uuid: string) =>
    `${JSON.stringify({
      type: "user",
      sessionId: ID,
      uuid,
      cwd: dir,
      timestamp: "2026-09-07T12:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text }] },
    })}\n`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tb-refresh-coord-"));
    const project = join(dir, "projects", "fixture");
    mkdirSync(project, { recursive: true });
    file = join(project, `${ID}.jsonl`);
    writeFileSync(file, turn("first", "turn-1"));
    scanner = new ConversationScanner({ persistent: false });
    manager = makeManager();
    manager.track(scanner);
    await scanner.refreshFile(file);
  });

  afterEach(async () => {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("post-write observes an append made inside the read TTL", async () => {
    expect((await manager.refreshFileForRead(scanner, file)).outcome).toBe("refreshed");
    appendFileSync(file, turn("second", "turn-2"));

    // The read path still throttles — that is what it is for.
    expect(await manager.refreshFileForRead(scanner, file)).toEqual({
      outcome: "skipped",
      meta: null,
    });
    const write = await manager.refreshFileAfterWrite(scanner, file);
    expect(write.outcome).toBe("refreshed");
    expect(write.meta?.messageCount).toBe(2);
    expect((await scanner.getConversation(ID))?.messages).toHaveLength(2);
  });

  it("directory reconciliation is post-write, so a recent read cannot throttle it out", async () => {
    await manager.refreshFileForRead(scanner, file);
    appendFileSync(file, turn("second", "turn-2"));
    const metas = await manager.refreshStaleFiles(scanner, [file]);
    expect(metas.map((m) => m.messageCount)).toEqual([2]);
  });

  it("the scanner coalesces concurrent calls but starts a new parse after settle", async () => {
    // The dependency semantics the follow-up pass relies on: refreshFile hands
    // a concurrent caller the in-flight parse (which is why a post-write must
    // never reach it directly), and has released it by the time a `.then` on
    // that parse runs (which is why starting the follow-up at settle works).
    const inFlight = scanner.refreshFile(file);
    expect(scanner.refreshFile(file)).toBe(inFlight);
    const followUp = await inFlight.then(() => {
      appendFileSync(file, turn("second", "turn-2"));
      const next = scanner.refreshFile(file);
      expect(next).not.toBe(inFlight);
      return next;
    });
    expect(followUp?.messageCount).toBe(2);
  });
});
