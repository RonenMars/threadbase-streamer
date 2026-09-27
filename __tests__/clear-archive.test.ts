import { createScreen, REPLAY_ARCHIVE_MAX_LINES, readReplayLines } from "../src/pty-shared";

/**
 * The render terminal keeps what a full clear erases.
 *
 * Claude Code writes `ESC[2J ESC[3J ESC[H` mid-turn and repaints only its
 * current frame, so without this a `terminal_replay` after a long turn held one
 * screen. Driven against the real @xterm/headless the runners use, because the
 * behaviour under test is how xterm's own erase and scrollback trimming move
 * rows around, not anything a stub would model.
 */

const CLAUDE_RESET = "\x1b[2J\x1b[3J\x1b[H";

function rows(prefix: string, n: number): string {
  return `${Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\r\n")}\r\n`;
}

function write(screen: ReturnType<typeof createScreen>, data: string): Promise<void> {
  return new Promise((resolve) => screen.write(data, () => resolve()));
}

describe("ClearArchive", () => {
  it("keeps the rows Claude Code's full reset erases, ahead of the repainted frame", async () => {
    const screen = createScreen();
    await write(screen, rows("history ", 150));
    await write(screen, CLAUDE_RESET + rows("frame ", 10));

    const { lines, archivedLineCount } = await readReplayLines(screen, 1040);
    expect(archivedLineCount).toBe(150);
    expect(lines.slice(0, archivedLineCount)).toEqual(
      Array.from({ length: 150 }, (_, i) => `history ${i}`),
    );
    expect(lines.slice(archivedLineCount)).toEqual(
      Array.from({ length: 10 }, (_, i) => `frame ${i}`),
    );
  });

  it("accumulates across repeated resets in order", async () => {
    const screen = createScreen();
    await write(screen, rows("a", 50));
    await write(screen, CLAUDE_RESET + rows("b", 60));
    await write(screen, CLAUDE_RESET + rows("c", 5));

    const { lines, archivedLineCount } = await readReplayLines(screen, 1040);
    expect(archivedLineCount).toBe(110);
    expect([lines[0], lines[49], lines[50], lines[109]]).toEqual(["a0", "a49", "b0", "b59"]);
    expect(lines.slice(archivedLineCount)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  // xterm's 2J erases the viewport but keeps its scrollback. Those rows are in
  // the archive already, so they must not be replayed a second time.
  it("does not replay scrollback that a 2J alone left in place", async () => {
    const screen = createScreen();
    await write(screen, rows("h", 150));
    await write(screen, `\x1b[2J\x1b[H${rows("f", 60)}`);

    const { lines, archivedLineCount } = await readReplayLines(screen, 1040);
    expect(archivedLineCount).toBe(150);
    expect(lines.slice(archivedLineCount)[0]).toBe("f0");
    expect(lines.filter((l) => l === "h0")).toHaveLength(1);

    await write(screen, CLAUDE_RESET + rows("z", 3));
    const after = await readReplayLines(screen, 1040);
    expect(after.archivedLineCount).toBe(210);
    expect(after.lines.slice(after.archivedLineCount)).toEqual(["z0", "z1", "z2"]);
  });

  it("keeps the viewport on screen for a 3J alone and archives only the scrollback", async () => {
    const screen = createScreen();
    await write(screen, rows("h", 150));
    await write(screen, "\x1b[3J");

    const { lines, archivedLineCount } = await readReplayLines(screen, 1040);
    expect(lines).toHaveLength(150);
    expect(lines.slice(archivedLineCount)[0]).toBe(`h${archivedLineCount}`);
    expect(lines.at(-1)).toBe("h149");
  });

  it("archives nothing for a clear on an empty screen", async () => {
    const screen = createScreen();
    await write(screen, CLAUDE_RESET + rows("f", 3));

    expect(await readReplayLines(screen, 1040)).toEqual({
      lines: ["f0", "f1", "f2"],
      archivedLineCount: 0,
    });
  });

  // A full-screen app on the alternate buffer clearing to redraw is not
  // history; archiving it would replay every redraw as a new page.
  it("ignores clears on the alternate buffer", async () => {
    const screen = createScreen();
    await write(screen, rows("main", 5));
    await write(screen, `\x1b[?1049h${rows("alt", 5)}${CLAUDE_RESET}${rows("alt2", 2)}`);

    const { archivedLineCount } = await readReplayLines(screen, 1040);
    expect(archivedLineCount).toBe(0);
  });

  it("caps the archive at REPLAY_ARCHIVE_MAX_LINES, dropping the oldest rows", async () => {
    const screen = createScreen();
    const pages = Math.ceil(REPLAY_ARCHIVE_MAX_LINES / 900) + 1;
    for (let p = 0; p < pages; p++) {
      await write(screen, rows(`p${p}-`, 900) + CLAUDE_RESET);
    }

    const { lines, archivedLineCount } = await readReplayLines(screen, 1040);
    expect(archivedLineCount).toBe(REPLAY_ARCHIVE_MAX_LINES);
    expect(lines.at(archivedLineCount - 1)).toBe(`p${pages - 1}-899`);
    expect(lines[0]).not.toBe("p0-0");
  });

  it("caps the live part at maxLines without touching the archive", async () => {
    const screen = createScreen();
    await write(screen, rows("h", 20));
    await write(screen, CLAUDE_RESET + rows("f", 30));

    const { lines, archivedLineCount } = await readReplayLines(screen, 5);
    expect(archivedLineCount).toBe(20);
    expect(lines.slice(archivedLineCount)).toEqual(["f25", "f26", "f27", "f28", "f29"]);
  });
});
