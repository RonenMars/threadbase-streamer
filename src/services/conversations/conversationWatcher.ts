import chokidar, { type FSWatcher } from "chokidar";
import { statSync } from "fs";
import { open, stat } from "fs/promises";
import { type LineSpan, splitCompleteLines } from "../../utils/fileIdentity";

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
  /**
   * Like onNewLines but also carries each line's absolute byte span in the
   * file (for the offset index). Fires ALONGSIDE onNewLines/onNewLine (it does
   * not replace them) so the cache tail write and the index extend can both
   * consume the same read. `readFrom` is the absolute byte offset the read
   * started at; `spans` are complete lines only (a torn trailing line is held
   * for the next read).
   */
  onNewLineSpans?: (filePath: string, spans: LineSpan[], readFrom: number) => void;
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
  private onNewLineSpans: ConversationWatcherEvents["onNewLineSpans"];
  private onConversationChanged: ConversationWatcherEvents["onConversationChanged"];
  private onFileDeleted: ConversationWatcherEvents["onFileDeleted"];
  private onError: ConversationWatcherEvents["onError"];

  constructor(events: ConversationWatcherEvents = {}) {
    this.onNewLine = events.onNewLine;
    this.onNewLines = events.onNewLines;
    this.onNewLineSpans = events.onNewLineSpans;
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
   * Re-drive the tail read for a file that's already being tailed. A per-file
   * chokidar handle can die silently (fs.watch stops firing after inode churn)
   * while the coarser directory watcher keeps reporting changes — calling this
   * from the directory-event path makes the tail self-healing. Reads are
   * offset-based and coalesced, so a redundant poke after a normal change
   * event is a cheap stat + no-op. Returns false for untailed paths.
   */
  poke(filePath: string): boolean {
    if (!this.files.has(filePath)) return false;
    void this.readNewLines(filePath);
    return true;
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
        // Split into complete lines only, with absolute byte spans. Advance by
        // `consumed` (up to the last "\n"), NOT `bytesToRead`: a trailing
        // partial line (no "\n" yet) is left unconsumed so `offset` never moves
        // past an unparsed line — it arrives whole on the next read. The file
        // may have grown again mid-read; the next loop iteration's stat catches
        // the rest.
        const { spans, consumed } = splitCompleteLines(buf, readFrom);
        entry.offset = readFrom + consumed;

        // The watcher may have been closed while we awaited; don't emit then.
        if (!this.files.has(filePath)) return;

        const lines = spans.map((s) => s.text);
        // The spans callback (offset index) fires alongside the text callbacks
        // — they consume the same read, so a burst extends the index and writes
        // the tail in one pass.
        if (spans.length > 0) this.onNewLineSpans?.(filePath, spans, readFrom);
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
      // If a change arrived while this read was in flight but the loop exited
      // before consuming it (e.g. an error broke out of the loop), the pending
      // bytes would otherwise sit unread until the next write. Re-arm once so
      // they're picked up — guarded by files.has so a disposed watcher stays put.
      if (entry.pending && this.files.has(filePath)) {
        entry.pending = false;
        void this.readNewLines(filePath);
      }
    }
  }
}
