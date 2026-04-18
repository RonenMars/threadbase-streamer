import type { FSWatcher } from "fs";
import { closeSync, openSync, readSync, statSync, watch } from "fs";
import type { FileWatcherEvents } from "./types";

interface WatchedFile {
  watcher: FSWatcher;
  offset: number;
}

export class FileWatcher {
  private watched = new Map<string, WatchedFile>();
  private onNewLine: FileWatcherEvents["onNewLine"];
  private onError: FileWatcherEvents["onError"];

  constructor(events: FileWatcherEvents = {}) {
    this.onNewLine = events.onNewLine;
    this.onError = events.onError;
  }

  watch(filePath: string): void {
    if (this.watched.has(filePath)) return;

    // Start from current end of file
    let offset: number;
    try {
      offset = statSync(filePath).size;
    } catch {
      offset = 0;
    }

    const watcher = watch(filePath, (eventType) => {
      if (eventType !== "change") return;
      this.readNewLines(filePath);
    });

    watcher.on("error", (err) => {
      this.onError?.(filePath, err);
    });

    this.watched.set(filePath, { watcher, offset });
  }

  unwatch(filePath: string): void {
    const entry = this.watched.get(filePath);
    if (!entry) return;
    entry.watcher.close();
    this.watched.delete(filePath);
  }

  dispose(): void {
    for (const [path] of this.watched) {
      this.unwatch(path);
    }
  }

  private readNewLines(filePath: string): void {
    const entry = this.watched.get(filePath);
    if (!entry) return;

    try {
      const stat = statSync(filePath);
      if (stat.size <= entry.offset) return;

      const bytesToRead = stat.size - entry.offset;
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(filePath, "r");
      readSync(fd, buf, 0, bytesToRead, entry.offset);
      closeSync(fd);
      const newData = buf.toString("utf-8");
      entry.offset = stat.size;

      const lines = newData.split("\n").filter(Boolean);
      for (const line of lines) {
        this.onNewLine?.(filePath, line);
      }
    } catch (err) {
      this.onError?.(filePath, err instanceof Error ? err : new Error(String(err)));
    }
  }
}
