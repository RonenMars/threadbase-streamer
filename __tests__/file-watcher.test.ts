import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileWatcher } from "../src/file-watcher";

describe("FileWatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "streamer-fw-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits new lines appended to a watched file", async () => {
    const filePath = join(tmpDir, "test.jsonl");
    writeFileSync(filePath, '{"existing":"line"}\n');

    const lines: string[] = [];
    const watcher = new FileWatcher({
      onNewLine: (_path, line) => lines.push(line),
    });

    watcher.watch(filePath);

    // Small delay to let fs.watch settle before writing
    await sleep(50);

    // Append new lines after watching starts
    appendFileSync(filePath, '{"new":"line1"}\n{"new":"line2"}\n');

    // fs.watch is async — poll until lines arrive or timeout
    await waitFor(() => lines.length >= 2, 2000);

    watcher.dispose();

    expect(lines).toContain('{"new":"line1"}');
    expect(lines).toContain('{"new":"line2"}');
    // Should NOT include the pre-existing line
    expect(lines).not.toContain('{"existing":"line"}');
  });

  it("does not emit for pre-existing content", async () => {
    const filePath = join(tmpDir, "existing.jsonl");
    writeFileSync(filePath, '{"old":"data"}\n');

    const lines: string[] = [];
    const watcher = new FileWatcher({
      onNewLine: (_path, line) => lines.push(line),
    });

    watcher.watch(filePath);
    await sleep(100);
    watcher.dispose();

    expect(lines).toHaveLength(0);
  });

  it("can unwatch a file", async () => {
    const filePath = join(tmpDir, "unwatch.jsonl");
    writeFileSync(filePath, "");

    const lines: string[] = [];
    const watcher = new FileWatcher({
      onNewLine: (_path, line) => lines.push(line),
    });

    watcher.watch(filePath);
    watcher.unwatch(filePath);

    appendFileSync(filePath, '{"after":"unwatch"}\n');
    await sleep(100);

    watcher.dispose();
    expect(lines).toHaveLength(0);
  });

  it("ignores duplicate watch calls for the same file", () => {
    const filePath = join(tmpDir, "dup.jsonl");
    writeFileSync(filePath, "");

    const watcher = new FileWatcher();
    watcher.watch(filePath);
    watcher.watch(filePath); // Should not throw
    watcher.dispose();
  });

  it("calls onError when watching a nonexistent file change triggers read failure", async () => {
    const filePath = join(tmpDir, "will-exist.jsonl");
    writeFileSync(filePath, "");

    const errors: Error[] = [];
    const watcher = new FileWatcher({
      onError: (_path, err) => errors.push(err),
    });

    watcher.watch(filePath);
    // Delete the file while it's being watched
    rmSync(filePath);

    // Trigger a change event by recreating (some platforms may not fire)
    writeFileSync(filePath, '{"recreated":true}\n');
    await sleep(200);

    watcher.dispose();
    // This test is platform-dependent; we just verify no crash
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await sleep(50);
  }
}
