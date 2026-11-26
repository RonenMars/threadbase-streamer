// A form taller than the PTY scrolls its tab bar and question off screen, and
// stale scrollback above it then supplies another tab's question. Replays real
// Claude Code 2.1.332 recordings through PTYManager, which reads the last rows
// of the whole buffer (render-raw.ts reads from the top and would miss this).

import { readFileSync } from "fs";
import { join } from "path";
import { PTYManager } from "../src/pty-manager";
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
