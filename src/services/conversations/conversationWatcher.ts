import chokidar, { type FSWatcher } from "chokidar";
import { statSync } from "fs";
import { open, stat } from "fs/promises";

export interface ConversationWatcherEvents {
  /** Fires once per new newline-terminated line appended to a watched file. */
  onNewLine?: (filePath: string, line: string) => void;
  /**
   * Fires once per chokidar read with ALL new lines from that read, batched.
   * When set, it REPLACES the per-line onNewLine dispatch for that file —
   * callers pick one. Lets a burst of appended lines collapse into a single
   * downstream cache write + WebSocket broadcast.
   */
  onNewLines?: (filePath: string, lines: string[]) => void;
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
  // Async-read re-entrancy guard: `reading` is set while a readNewLines is in
  // flight; `pending` records that a change arrived during that read so the
  // in-flight loop re-runs once more after it finishes.
  reading: boolean;
  pending: boolean;
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
  private onNewLines: ConversationWatcherEvents["onNewLines"];
  private onConversationChanged: ConversationWatcherEvents["onConversationChanged"];
  private onFileDeleted: ConversationWatcherEvents["onFileDeleted"];
  private onError: ConversationWatcherEvents["onError"];

  constructor(events: ConversationWatcherEvents = {}) {
    this.onNewLine = events.onNewLine;
    this.onNewLines = events.onNewLines;
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

    watcher.on("change", () => {
      void this.readNewLines(filePath);
    });
    watcher.on("add", () => {
      void this.readNewLines(filePath);
    });
    watcher.on("unlink", () => this.onFileDeleted?.(filePath));
    watcher.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(filePath, error);
    });

    this.files.set(filePath, { watcher, offset, reading: false, pending: false });
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

  private async readNewLines(filePath: string): Promise<void> {
    const entry = this.files.get(filePath);
    if (!entry) return;

    // Coalesce: if a read is already running, flag that another change arrived;
    // the in-flight loop will pick up the freshly-appended bytes before exiting.
    if (entry.reading) {
      entry.pending = true;
      return;
    }
    entry.reading = true;

    try {
      // Loop so bytes appended during a read (or while dispatching) are caught
      // without re-entering — preserves offset correctness under async I/O.
      for (;;) {
        const st = await stat(filePath);
        // size <= offset also covers truncation/rotation, exactly as before.
        if (st.size <= entry.offset) break;

        const readFrom = entry.offset;
        const bytesToRead = st.size - readFrom;
        const buf = Buffer.alloc(bytesToRead);
        const fh = await open(filePath, "r");
        try {
          await fh.read(buf, 0, bytesToRead, readFrom);
        } finally {
          await fh.close();
        }
        // Advance by exactly what we read (NOT a re-stat'd size): the file may
        // have grown again mid-read; the next loop iteration's stat catches it.
        // This reproduces the old `offset = stat.size` semantics, including the
        // drop of a trailing partial line (no \n yet) via filter(Boolean).
        entry.offset = readFrom + bytesToRead;

        // The watcher may have been closed while we awaited; don't emit then.
        if (!this.files.has(filePath)) return;

        const lines = buf.toString("utf-8").split("\n").filter(Boolean);
        if (this.onNewLines) {
          this.onNewLines(filePath, lines);
        } else {
          for (const line of lines) this.onNewLine?.(filePath, line);
        }

        if (entry.pending) {
          entry.pending = false;
          continue;
        }
        break;
      }
    } catch (err) {
      this.onError?.(filePath, err instanceof Error ? err : new Error(String(err)));
    } finally {
      entry.reading = false;
    }
  }
}
