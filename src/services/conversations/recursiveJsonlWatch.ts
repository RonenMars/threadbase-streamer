import { watch as fsWatch } from "fs";
import { join } from "path";

/** A directory watch the ConversationWatcher can close or silence. */
export interface DirectoryWatch {
  close(): void | Promise<void>;
  /** Stop delivering without closing the OS handle (see ConversationWatcher.detach). */
  detach(): void;
}

/**
 * One recursive `fs.watch` over a whole directory tree, reporting `.jsonl` paths.
 *
 * On macOS Node backs a recursive watch with a single FSEvents stream, where
 * chokidar opens one `fs.watch` handle per transcript. A populated
 * `~/.claude/projects` (~3000 files) crosses the FSEvents ceiling that way; the
 * resulting EMFILE then closes the handles one by one from inside the event
 * callback, each close blocking while libuv rebuilds the shared stream, which
 * stalled the event loop for minutes on every boot.
 *
 * Reports are trailing-debounced per path by `settleMs`, matching the
 * `awaitWriteFinish` the chokidar watch used, so a burst of appends is one event.
 */
export function watchJsonlRecursively(
  directory: string,
  onChange: (filePath: string) => void,
  onError: (error: Error) => void,
  settleMs = 500,
): DirectoryWatch {
  const pending = new Map<string, NodeJS.Timeout>();
  const clearPending = () => {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  };
  const watcher = fsWatch(directory, { recursive: true }, (_event, name) => {
    if (!name || !/\.jsonl$/i.test(name)) return;
    const file = join(directory, name.toString());
    clearTimeout(pending.get(file));
    pending.set(
      file,
      setTimeout(() => {
        pending.delete(file);
        onChange(file);
      }, settleMs),
    );
  });
  watcher.on("error", (err) => onError(err instanceof Error ? err : new Error(String(err))));
  return {
    close() {
      clearPending();
      watcher.close();
    },
    detach() {
      clearPending();
      watcher.removeAllListeners();
      watcher.on("error", () => {});
    },
  };
}
