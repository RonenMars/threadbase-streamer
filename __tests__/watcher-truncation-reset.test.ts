import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationWatcher } from "../src/services/conversations/conversationWatcher";

// P4.b: before this, the tail's only truncation handling was `size <= offset →
// break`, with no reset. An in-place truncate+rewrite left the offset past EOF:
// the tail went silent until the file grew back past the stale offset, then
// resumed MID-LINE, splicing the new file's content onto the old conversation.
describe("ConversationWatcher truncation reset", () => {
  let dir: string;
  let file: string;
  let watcher: ConversationWatcher;

  const line = (text: string) => `${JSON.stringify({ type: "user", text })}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-trunc-"));
    file = join(dir, "conv.jsonl");
  });

  afterEach(() => {
    watcher?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  async function settle(ms = 400) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("resets to byte 0 and re-reads a file replaced by a SHORTER one", async () => {
    // Start from a long file so the post-truncation size is below our offset.
    writeFileSync(file, line("old-a") + line("old-b") + line("old-c") + line("old-d"));

    const received: string[] = [];
    const truncated: string[] = [];
    watcher = new ConversationWatcher({
      onNewLines: (_p, lines) => received.push(...lines),
      onTruncated: (p) => truncated.push(p),
    });
    watcher.watch(file); // seeds offset at current EOF

    // Replace in place with a SHORTER file — same path, no unlink event.
    writeFileSync(file, line("fresh-1"));
    watcher.poke(file);
    await settle();

    // The truncation was reported so the consumer can drop its byte index...
    expect(truncated).toHaveLength(1);
    // ...and the new content was read whole rather than spliced mid-line.
    expect(received.join("\n")).toContain("fresh-1");
    expect(received.join("\n")).not.toContain("old-");
    // Every emitted line is intact JSON — no fragment from a mid-file resume.
    for (const l of received) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("keeps appending normally after the reset", async () => {
    writeFileSync(file, line("old-a") + line("old-b") + line("old-c"));

    const received: string[] = [];
    watcher = new ConversationWatcher({ onNewLines: (_p, lines) => received.push(...lines) });
    watcher.watch(file);

    writeFileSync(file, line("fresh-1"));
    watcher.poke(file);
    await settle();

    appendFileSync(file, line("fresh-2"));
    watcher.poke(file);
    await settle();

    const joined = received.join("\n");
    expect(joined).toContain("fresh-1");
    expect(joined).toContain("fresh-2");
    // Exactly once each — the reset must not replay content twice.
    expect(received.filter((l) => l.includes("fresh-1"))).toHaveLength(1);
    expect(received.filter((l) => l.includes("fresh-2"))).toHaveLength(1);
  });

  it("does not fire onTruncated for an ordinary append", async () => {
    writeFileSync(file, line("a"));

    const truncated: string[] = [];
    watcher = new ConversationWatcher({
      onNewLines: () => {},
      onTruncated: (p) => truncated.push(p),
    });
    watcher.watch(file);

    appendFileSync(file, line("b"));
    watcher.poke(file);
    await settle();

    expect(truncated).toHaveLength(0);
  });
});
