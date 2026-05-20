import chokidar, { type FSWatcher } from "chokidar";
import { closeSync, openSync, readSync, statSync } from "fs";

export interface ConversationWatcherEvents {
  /** Fires once per new newline-terminated line appended to a watched file. */
  onNewLine?: (filePath: string, line: string) => void;
  /** Fires when chokidar reports an add/change/unlink at the directory level. */
  onConversationChanged?: (filePath: string) => void | Promise<void>;
  /** Fires when a tailed file is deleted (per-file watcher unlink event). */
  onFileDeleted?: (filePath: string) => void;
  /** Reported errors per file. */
  onError?: (filePath: string, error: Error) => void;
}

interface WatchedFile {
  watcher: FSWatcher;
  offset: number;
}

/**
 * Chokidar-backed replacement for src/file-watcher.ts.
 *
 *   - watch(filePath)      → tail a single JSONL file, emitting onNewLine
 *                            for each appended line.
 *   - watchDirectory(dir)  → mark cache dirty on add/change/unlink events
 *                            for any file inside the directory.
 *
 * Per the refactor plan, file watching is an OPTIMIZATION; correctness
 * still relies on refresh=1 / the latest HDD conversation id check.
 */
export class ConversationWatcher {
  private files = new Map<string, WatchedFile>();
  private directories = new Map<string, FSWatcher>();
  private onNewLine: ConversationWatcherEvents["onNewLine"];
  private onConversationChanged: ConversationWatcherEvents["onConversationChanged"];
  private onFileDeleted: ConversationWatcherEvents["onFileDeleted"];
  private onError: ConversationWatcherEvents["onError"];

  constructor(events: ConversationWatcherEvents = {}) {
    this.onNewLine = events.onNewLine;
    this.onConversationChanged = events.onConversationChanged;
    this.onFileDeleted = events.onFileDeleted;
    this.onError = events.onError;
  }

  watch(filePath: string): void {
    if (this.files.has(filePath)) return;

    let offset: number;
    try {
      offset = statSync(filePath).size;
    } catch {
      offset = 0;
    }

    const watcher = chokidar.watch(filePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });

    watcher.on("change", () => this.readNewLines(filePath));
    watcher.on("add", () => this.readNewLines(filePath));
    watcher.on("unlink", () => this.onFileDeleted?.(filePath));
    watcher.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(filePath, error);
    });

    this.files.set(filePath, { watcher, offset });
  }

  unwatch(filePath: string): void {
    const entry = this.files.get(filePath);
    if (!entry) return;
    void entry.watcher.close();
    this.files.delete(filePath);
  }

  /**
   * Watch a directory of conversation JSONL files. Fires
   * onConversationChanged for any add/change/unlink event so the caller
   * can mark the cache dirty without scanning everything immediately.
   */
  watchDirectory(directory: string): void {
    if (this.directories.has(directory)) return;
    const watcher = chokidar.watch(directory, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    const fire = (filePath: string) => {
      void Promise.resolve(this.onConversationChanged?.(filePath)).catch(() => {
        // best-effort
      });
    };
    watcher.on("add", fire);
    watcher.on("change", fire);
    watcher.on("unlink", fire);
    watcher.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(directory, error);
    });
    this.directories.set(directory, watcher);
  }

  unwatchDirectory(directory: string): void {
    const watcher = this.directories.get(directory);
    if (!watcher) return;
    void watcher.close();
    this.directories.delete(directory);
  }

  dispose(): void {
    for (const [path] of this.files) this.unwatch(path);
    for (const [dir] of this.directories) this.unwatchDirectory(dir);
  }

  private readNewLines(filePath: string): void {
    const entry = this.files.get(filePath);
    if (!entry) return;

    try {
      const stat = statSync(filePath);
      if (stat.size <= entry.offset) return;

      const bytesToRead = stat.size - entry.offset;
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(filePath, "r");
      readSync(fd, buf, 0, bytesToRead, entry.offset);
      closeSync(fd);
      entry.offset = stat.size;

      const lines = buf.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        this.onNewLine?.(filePath, line);
      }
    } catch (err) {
      this.onError?.(filePath, err instanceof Error ? err : new Error(String(err)));
    }
  }
}
