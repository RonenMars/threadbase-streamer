// A form taller than the PTY scrolls its tab bar and question off screen, and
// stale scrollback above it then supplies another tab's question. Replays real
// Claude Code 2.1.332 recordings through PTYManager, which reads the last rows
// of the whole buffer (render-raw.ts reads from the top and would miss this).

import { readFileSync } from "fs";
import { join } from "path";
import { PTYManager } from "../src/pty-manager";
import { isUnreadableQuestionForm } from "../src/services/questions/detectQuestionFromScreen";
import type { AskQuestion } from "../src/types";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    let emit: (data: string) => void = () => {};
    return {
      pid: 12345,
      onData: (cb: (data: string) => void) => {
        emit = cb;
      },
      onExit: () => {},
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      _emit: (data: string) => emit(data),
    };
  }),
}));

const fixture = (name: string) =>
  readFileSync(
    join(__dirname, "fixtures", "ask-user-question", `claude-2.1.332-${name}.raw`),
    "utf8",
  );

async function cardsFrom(name: string, cols: number, rows: number): Promise<AskQuestion[][]> {
  const cards: AskQuestion[][] = [];
  const mgr = new PTYManager({ onLiveQuestion: (_id, questions) => cards.push(questions) });
  const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
  mgr.resize(session.id, cols, rows);
  // Detection waits out the repaint that follows a size change.
  await new Promise((resolve) => setTimeout(resolve, 350));
  (mgr as any).sessions.get(session.id).process._emit(fixture(name));
  // Detection awaits the same xterm flush as this read, queued before it.
  await mgr.getOutputLines(session.id, rows);
  await new Promise((resolve) => setTimeout(resolve, 20));
  mgr.dispose();
  return cards;
}

describe("a question form taller than the PTY", () => {
  it("still raises a card for a form that fits (control)", async () => {
    const cards = await cardsFrom("two-single-tab1", 120, 40);
    expect(cards.at(-1)?.[0].question).toBe("Pick a fruit?");
  });

  // `[]` = a form is up (push, and "gone" later) but nothing on screen can be shown.
  it.each([
    ["overflow-tab1", 120, 40],
    ["overflow-tab2", 120, 40],
    ["120x24-overflow-tab2", 120, 24],
    ["120x24-overflow-back-to-tab1", 120, 24],
    // The tab bar stays; only the option list scrolls.
    ["120x12-windowed-tab1", 120, 12],
  ])("reports %s as a form with no readable question", async (name, cols, rows) => {
    expect(await cardsFrom(name, cols, rows)).toEqual([[]]);
  });
});

describe("an unreadable form that closes", () => {
  it("reports gone once the prompt is back", async () => {
    const events: string[] = [];
    const mgr = new PTYManager({
      onLiveQuestion: (_id, questions) => events.push(`question:${questions.length}`),
      onLiveQuestionGone: () => events.push("gone"),
    });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const emit = (data: string) => (mgr as any).sessions.get(session.id).process._emit(data);
    emit(fixture("overflow-tab1"));
    await vi.waitFor(() => expect(events).toEqual(["question:0"]));
    emit("\x1b[3J\x1b[2J\x1b[H\u276f ");
    await vi.waitFor(() => expect(events).toEqual(["question:0", "gone"]));
    mgr.dispose();
  });
});

describe("a question form with option previews", () => {
  it.each([
    ["preview-tab1", 120],
    ["preview-revisit", 120],
    ["preview-cursor-on-chat", 120],
    ["80x40-preview-tab1", 80],
  ])("reports %s as a form with no readable question", async (name, cols) => {
    expect(await cardsFrom(name, cols, 40)).toEqual([[]]);
  });
});

// After a resize Claude Code clears the screen and repaints it over several
// chunks, with no marker for where the frame ends (recorded on 2.1.332: header
// and the user's echoed message, then the menu, then its footer).
describe("a form being repainted after a resize", () => {
  const OSC_PERMISSION = "\x1b]777;notify;Claude Code;Claude needs your permission\x07";
  const OSC_WAITING = "\x1b]777;notify;Claude Code;Claude is waiting for your input\x07";

  async function watched() {
    const events: string[] = [];
    const mgr = new PTYManager({
      onLiveQuestion: (_id, questions) => events.push(`question:${questions[0]?.question}`),
      onLiveQuestionGone: () => events.push("gone"),
      onPermissionChange: (_id, gate) => {
        events.push(gate ? "permission" : "permission_closed");
      },
    });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const emit = async (data: string) => {
      (mgr as any).sessions.get(session.id).process._emit(data);
      await mgr.getOutputLines(session.id, 40);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    return { mgr, id: session.id, events, emit };
  }

  it("neither reports the menu gone nor reads half of it as a permission gate", async () => {
    const { mgr, id, events, emit } = await watched();
    await emit(fixture("two-single-tab1"));
    await vi.waitFor(() => expect(events).toEqual(["question:Pick a fruit?"]));
    const rows = await mgr.getOutputLines(id, 40);
    const bar = rows.findLastIndex((row) => row.includes("✔ Submit"));
    const typeRow = rows.findLastIndex((row) => row.includes("Type something"));

    mgr.resize(id, 120, 30);
    await emit("\x1b[2J\x1b[H❯ Ask me two questions\r\n");
    await emit(`${rows.slice(bar, typeRow + 1).join("\r\n")}\r\n`);
    await emit(rows.slice(typeRow + 1).join("\r\n"));
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(events).toEqual(["question:Pick a fruit?"]);
    mgr.dispose();
  });

  it("reads the screen once it has settled, even with no further output", async () => {
    const { mgr, id, events, emit } = await watched();
    mgr.resize(id, 100, 40);
    await emit(fixture("two-single-tab1"));
    expect(events).toEqual([]);
    await vi.waitFor(() => expect(events).toEqual(["question:Pick a fruit?"]), { timeout: 1500 });
    mgr.dispose();
  });

  it("holds nothing back for a resize that changes nothing", async () => {
    const { mgr, id, events, emit } = await watched();
    mgr.resize(id, 120, 40);
    await emit(fixture("two-single-tab1"));
    expect(events).toEqual(["question:Pick a fruit?"]);
    mgr.dispose();
  });

  it("does not hold back the notifications that open and close a gate", async () => {
    const { mgr, id, events, emit } = await watched();
    mgr.resize(id, 120, 30);
    await emit(OSC_PERMISSION);
    expect(events).toEqual(["permission"]);
    mgr.resize(id, 120, 24);
    await emit(OSC_WAITING);
    expect(events).toEqual(["permission", "permission_closed"]);
    mgr.dispose();
  });
});

// `Chat about this` stays below a scrolled option list, so its number says how
// many rows must be above it. The row under the cursor shows no scroll arrow.
describe("an option list scrolled inside the form", () => {
  const form = (...options: string[]) => [
    "  1. an older list in the scrollback",
    "  2. above the form",
    "  3. must not fill",
    "  4. the gap",
    "←  ☐ Fruit  ☐ Toppings  ✔ Submit  →",
    "Pick a fruit?",
    ...options,
    "─".repeat(40),
    "  5. Chat about this",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ];

  it.each([
    ["rows hidden below, with no arrow", ["  1. Apple", "❯ 2. Pear"]],
    ["rows hidden below, with an arrow", ["❯ 1. Apple", "↓ 2. Pear"]],
    ["rows hidden above, with no arrow", ["❯ 3. Plum", "  4. Type something."]],
    ["rows hidden above, with an arrow", ["↑ 3. Plum", "❯ 4. Type something."]],
    ["rows hidden on both sides", ["↑ 2. Pear", "❯ 3. Plum"]],
    ["only the first row hidden", ["❯ 2. Pear", "  3. Plum", "  4. Type something."]],
  ])("is unreadable with %s", (_name, options) => {
    expect(isUnreadableQuestionForm(form(...options))).toBe(true);
  });

  it("is readable when every row is there (control)", () => {
    const rows = ["❯ 1. Apple", "     Crisp", "  2. Pear", "  3. Plum", "  4. Type something."];
    expect(isUnreadableQuestionForm(form(...rows))).toBe(false);
  });

  it("is unreadable with the cursor on the pinned row", () => {
    const rows = form("  1. Apple", "↓ 2. Pear").map((row) =>
      row.replace("  5. Chat", "❯ 5. Chat"),
    );
    expect(isUnreadableQuestionForm(rows)).toBe(true);
  });

  it("goes by the form above the footer, not by rows under it", () => {
    const rows = [...form("❯ 1. Apple", "↓ 2. Pear"), "  1. Chat about this"];
    expect(isUnreadableQuestionForm(rows)).toBe(true);
  });

  it("sees a scrolled list inside a box gutter", () => {
    const rows = form("❯ 1. Apple", "↓ 2. Pear").map((row) => `│ ${row}`);
    expect(isUnreadableQuestionForm(rows)).toBe(true);
  });

  it("reads rows inside a box gutter", () => {
    const rows = ["  1. Apple", "  2. Pear", "  3. Plum", "  4. Type something."];
    expect(isUnreadableQuestionForm(form(...rows).map((row) => `│ ${row}`))).toBe(false);
  });
});
