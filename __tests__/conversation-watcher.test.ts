import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";

// Mock chokidar BEFORE the watcher module is imported.
const mockWatcher = () => {
  const ee = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
  ee.close = vi.fn().mockResolvedValue(undefined);
  return ee;
};
const watchSpy = vi.fn();

vi.mock("chokidar", () => ({
  default: {
    watch: (...args: unknown[]) => {
      watchSpy(...args);
      return mockWatcher();
    },
  },
}));

import { ConversationWatcher } from "../src/services/conversations/conversationWatcher";

describe("ConversationWatcher", () => {
  it("registers a chokidar watcher when watchDirectory is called", () => {
    const onChanged = vi.fn();
    const w = new ConversationWatcher({ onConversationChanged: onChanged });
    w.watchDirectory("/some/dir");
    expect(watchSpy).toHaveBeenCalled();
    w.dispose();
  });

  it("does not double-register the same directory", () => {
    watchSpy.mockClear();
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
