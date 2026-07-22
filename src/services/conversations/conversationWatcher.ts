import chokidar, { type FSWatcher } from "chokidar";
import { statSync } from "fs";
import { open, stat } from "fs/promises";
import { canonicalizeFilePath } from "../../utils/canonicalizeFilePath";
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
  onNewLineSpans?: (
    filePath: string,
    spans: LineSpan[],
    readFrom: number,
    endOffset: number,
  ) => void;
  /** Fires when chokidar reports an add/change/unlink at the directory level. */
  onConversationChanged?: (filePath: string) => void | Promise<void>;
  /** Fires when a tailed file is deleted (per-file watcher unlink event). */
  onFileDeleted?: (filePath: string) => void;
  /**
   * Fires when a tailed file shrank below our read offset (in-place truncation
   * or replacement by a shorter file). The tail has already reset to byte 0;
   * the consumer must discard any byte-offset index built for the old content,
   * which no longer describes this file.
   */
  onTruncated?: (filePath: string) => void;
  /** Reported errors per file. */
  onError?: (filePath: string, error: Error) => void;
}

interface WatchedFile {
  watcher: FSWatcher;
  offset: number;
  // The original (un-canonicalized) path passed to watch(). The `files` map is
  // keyed by the canonical path (so mixed-separator poke/unwatch match), but FS
  // reads and emitted callback paths use this original so the offset index's
  // stat identity is unchanged (P1.a).
  path: string;
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
  private onTruncated: ConversationWatcherEvents["onTruncated"];
  private onError: ConversationWatcherEvents["onError"];

  constructor(events: ConversationWatcherEvents = {}) {
    this.onNewLine = events.onNewLine;
    this.onNewLines = events.onNewLines;
    this.onNewLineSpans = events.onNewLineSpans;
    this.onConversationChanged = events.onConversationChanged;
    this.onFileDeleted = events.onFileDeleted;
    this.onTruncated = events.onTruncated;
    this.onError = events.onError;
  }

  watch(filePath: string): void {
    // Key the map by the canonical (forward-slash) path so a native-separator
    // path from a directory event (chokidar on Windows) resolves to the entry a
    // scanner-posix path registered — otherwise poke()/unwatch() miss and the
    // tail self-heal is dead (P1.a). FS reads and emitted callback paths keep the
    // original path (`entry.path`); its stat identity is what the offset index
    // relies on, so it must not be normalized.
    const key = canonicalizeFilePath(filePath);
    if (this.files.has(key)) return;

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
      void this.readNewLines(key);
    });
    watcher.on("add", () => {
      void this.readNewLines(key);
    });
    watcher.on("unlink", () => this.onFileDeleted?.(filePath));
    watcher.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(filePath, error);
    });

    this.files.set(key, { watcher, offset, reading: false, pending: false, path: filePath });
  }

  unwatch(filePath: string): void {
    const key = canonicalizeFilePath(filePath);
    const entry = this.files.get(key);
    if (!entry) return;
    void entry.watcher.close();
    this.files.delete(key);
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
    // Canonicalize so a directory event's native-separator path matches the entry
    // watch() keyed by the (possibly posix) scanner path (P1.a).
    const key = canonicalizeFilePath(filePath);
    if (!this.files.has(key)) return false;
    void this.readNewLines(key);
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

  private async readNewLines(key: string): Promise<void> {
    const entry = this.files.get(key);
    if (!entry) return;
    // Map is keyed by the canonical path; FS reads and emitted callbacks use the
    // original path so the offset index's stat identity is unchanged (P1.a).
    const filePath = entry.path;

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
        // Truncated or replaced by a SHORTER file: our offset now points past
        // EOF. Leaving it there makes the tail silently stall until the file
        // grows back past the stale offset and then resume mid-line, splicing
        // the new file's content onto the old conversation. Reset to the start
        // and tell the caller so it can drop the byte-offset index it built for
        // the previous generation of this file.
        if (st.size < entry.offset) {
          entry.offset = 0;
          this.onTruncated?.(filePath);
        }
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
        if (!this.files.has(key)) return;

        const lines = spans.map((s) => s.text);
        // The spans callback (offset index) fires alongside the text callbacks
        // — they consume the same read, so a burst extends the index and writes
        // the tail in one pass.
        // Pass both the start (readFrom) and the post-read end offset
        // (entry.offset = readFrom + consumed) so the index can enforce
        // contiguity and store the same offset the watcher tracks.
        if (spans.length > 0) {
          this.onNewLineSpans?.(filePath, spans, readFrom, entry.offset);
        }
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
      if (entry.pending && this.files.has(key)) {
        entry.pending = false;
        void this.readNewLines(key);
      }
    }
  }
}
