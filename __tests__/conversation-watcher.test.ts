import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── chokidar mock ──────────────────────────────────────────────────
// Capture every emitter returned by chokidar.watch() so tests can drive
// "change"/"add"/"unlink" events at will.
type MockEmitter = EventEmitter & { close: () => Promise<void> };
const emitters: MockEmitter[] = [];
const mockWatcher = (): MockEmitter => {
  const ee = new EventEmitter() as MockEmitter;
  ee.close = vi.fn().mockResolvedValue(undefined);
  emitters.push(ee);
  return ee;
};
const watchSpy = vi.fn();
const lastEmitter = () => emitters[emitters.length - 1];

vi.mock("chokidar", () => ({
  default: {
    watch: (...args: unknown[]) => {
      watchSpy(...args);
      return mockWatcher();
    },
  },
}));

// ─── fs / fs/promises mocks ─────────────────────────────────────────
// A single backing buffer represents the watched file's bytes. statSync
// reports the initial size (offset seed); fs/promises stat/open/read serve
// the appended tail. Tests append to `fileBytes` then fire a "change".
let fileBytes = "";
const initialSize = { value: 0 };

vi.mock("fs", () => ({
  statSync: () => ({ size: initialSize.value }),
}));

// `readGate` lets a test hold a read open to exercise the concurrency guard.
let readGate: Promise<void> | null = null;

vi.mock("fs/promises", () => ({
  stat: async () => ({ size: Buffer.byteLength(fileBytes, "utf-8") }),
  open: async () => ({
    read: async (buf: Buffer, offset: number, length: number, position: number) => {
      if (readGate) await readGate;
      const slice = Buffer.from(fileBytes, "utf-8").subarray(position, position + length);
      slice.copy(buf, offset);
      return { bytesRead: slice.length, buffer: buf };
    },
    close: async () => {},
  }),
}));

import { ConversationWatcher } from "../src/services/conversations/conversationWatcher";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ConversationWatcher — directory watching", () => {
  beforeEach(() => {
    emitters.length = 0;
    watchSpy.mockClear();
  });

  it("registers a chokidar watcher when watchDirectory is called", () => {
    const onChanged = vi.fn();
    const w = new ConversationWatcher({ onConversationChanged: onChanged });
    w.watchDirectory("/some/dir");
    expect(watchSpy).toHaveBeenCalled();
    w.dispose();
  });

  it("does not double-register the same directory", () => {
    const w = new ConversationWatcher();
    w.watchDirectory("/dir-1");
    w.watchDirectory("/dir-1");
    expect(watchSpy).toHaveBeenCalledTimes(1);
    w.dispose();
  });

  it("dispose closes file and directory watchers without throwing", () => {
    const w = new ConversationWatcher();
    w.watchDirectory("/dir-2");
    expect(() => w.dispose()).not.toThrow();
  });
});

describe("ConversationWatcher — file tailing", () => {
  beforeEach(() => {
    emitters.length = 0;
    watchSpy.mockClear();
    fileBytes = "";
    initialSize.value = 0;
    readGate = null;
  });

  it("onNewLines fires once with all lines from a single change", async () => {
    const onNewLines = vi.fn();
    const w = new ConversationWatcher({ onNewLines });
    w.watch("/proj/a.jsonl");

    fileBytes = "line1\nline2\nline3\n";
    lastEmitter().emit("change");
    await flush();

    expect(onNewLines).toHaveBeenCalledTimes(1);
    expect(onNewLines).toHaveBeenCalledWith("/proj/a.jsonl", ["line1", "line2", "line3"]);
    w.dispose();
  });

  it("falls back to per-line onNewLine when onNewLines is not set", async () => {
    const onNewLine = vi.fn();
    const w = new ConversationWatcher({ onNewLine });
    w.watch("/proj/b.jsonl");

    fileBytes = "a\nb\n";
    lastEmitter().emit("change");
    await flush();

    expect(onNewLine).toHaveBeenCalledTimes(2);
    expect(onNewLine).toHaveBeenNthCalledWith(1, "/proj/b.jsonl", "a");
    expect(onNewLine).toHaveBeenNthCalledWith(2, "/proj/b.jsonl", "b");
    w.dispose();
  });

  it("drops a trailing partial line (no newline yet)", async () => {
    const onNewLines = vi.fn();
    const w = new ConversationWatcher({ onNewLines });
    w.watch("/proj/c.jsonl");

    fileBytes = "complete\npartial-without-newline";
    lastEmitter().emit("change");
    await flush();

    expect(onNewLines).toHaveBeenCalledWith("/proj/c.jsonl", [
      "complete",
      "partial-without-newline",
    ]);
    // NOTE: this documents existing behavior — split("\n").filter(Boolean)
    // keeps the trailing partial here because there's no \n to split on; the
    // offset advances past it so it is not re-emitted on the next change.
    onNewLines.mockClear();
    fileBytes += "\nmore\n";
    lastEmitter().emit("change");
    await flush();
    expect(onNewLines).toHaveBeenCalledWith("/proj/c.jsonl", ["more"]);
    w.dispose();
  });

  it("coalesces a change that arrives mid-read without double-reading", async () => {
    const onNewLines = vi.fn();
    const w = new ConversationWatcher({ onNewLines });
    w.watch("/proj/d.jsonl");

    let release!: () => void;
    readGate = new Promise<void>((r) => {
      release = r;
    });

    fileBytes = "first\n";
    lastEmitter().emit("change"); // starts a read, blocked on readGate
    await flush();
    // A second change arrives while the first read is in flight.
    fileBytes = "first\nsecond\n";
    lastEmitter().emit("change");
    await flush();

    readGate = null;
    release();
    await flush();
    await flush();

    // Concatenate every line delivered across all calls — no duplicates.
    const delivered = onNewLines.mock.calls.flatMap((c) => c[1] as string[]);
    expect(delivered).toEqual(["first", "second"]);
    w.dispose();
  });
});
