// Copilot's blocking cards, parsed off the screens its raw PTY captures render
// (the captures themselves are pinned in pty-capture-fixtures.test.ts).
import { readFileSync } from "fs";
import { join } from "path";
import { createScreen, PTY_ROWS } from "../src/pty-shared";
import { detectCopilotCard } from "../src/services/questions/copilotScreen";

interface Capture {
  submitAt: number;
  marks: Record<string, number>;
  chunks: [number, string][];
}

const load = (name: string): Capture =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", "turn-signals", name), "utf8"));

/** The rendered rows once every chunk up to and including `ms` is written. */
async function rowsAt(cap: Capture, ms: number): Promise<string[]> {
  const screen = createScreen();
  for (const [at, data] of cap.chunks) {
    if (at > ms) break;
    await new Promise<void>((resolve) => screen.write(data, () => resolve()));
  }
  const buf = screen.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < PTY_ROWS; y++) {
    rows.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "");
  }
  screen.dispose();
  return rows;
}

const TURN = load("copilot-1.0.92-turn.json");
const GATE = load("copilot-1.0.92-gate.json");
const ASK = load("copilot-1.0.92-ask.json");
const DOWN = "\x1b[B";
const UP = "\x1b[A";

describe("detectCopilotCard", () => {
  it("reads the folder trust card, answered by arrows from the highlight and Enter", async () => {
    expect(detectCopilotCard(await rowsAt(TURN, TURN.marks.trustOpen))).toEqual({
      prompt: "Do you trust the files in this folder?",
      detail: [
        "Confirm folder trust",
        "/private/tmp/tb-capture-copilot-turn",
        "Copilot can read files in this folder and, with your permission, edit them or run code and shell commands. It will remember your permissions for the rest of this session.",
      ].join("\n"),
      options: [
        { index: 1, label: "Yes", answerKeys: "\r" },
        {
          index: 2,
          label: "Yes, and remember this folder for future sessions",
          answerKeys: `${DOWN}\r`,
        },
        { index: 3, label: "No (Esc)", answerKeys: `${DOWN}${DOWN}\r` },
      ],
      cursor: 1,
    });
  });

  it("reads the shell permission card with the command as its detail", async () => {
    expect(detectCopilotCard(await rowsAt(GATE, GATE.marks.gateOpen))).toEqual({
      prompt: "Do you want to run this command?",
      detail: "Create the requested empty file in the current workspace\ntouch a.txt",
      options: [
        { index: 1, label: "Yes", answerKeys: "\r" },
        {
          index: 2,
          label:
            "Yes, and don't ask again for `touch` in this directory (/private/tmp/tb-capture-copilot-gate)",
          answerKeys: `${DOWN}\r`,
        },
        {
          index: 3,
          label: "No, and tell Copilot what to do differently (Esc to stop)",
          answerKeys: `${DOWN}${DOWN}\r`,
        },
      ],
      cursor: 1,
    });
  });

  it("reads an ask_user choice, leaving out the free-text row", async () => {
    expect(detectCopilotCard(await rowsAt(ASK, ASK.marks.askOpen))).toEqual({
      prompt: "Pick one color out of red, green, and blue.",
      detail: "Color:\nChoose exactly one color.",
      options: [
        { index: 1, label: "red", answerKeys: "\r" },
        { index: 2, label: "green", answerKeys: `${DOWN}\r` },
        { index: 3, label: "blue", answerKeys: `${DOWN}${DOWN}\r` },
      ],
      cursor: 1,
    });
  });

  it("builds ask_user keys from wherever the highlight is", async () => {
    const rows = (await rowsAt(ASK, ASK.marks.askOpen)).map((row) =>
      row.replace(" ❯ red", "   red").replace("   blue", " ❯ blue"),
    );
    const card = detectCopilotCard(rows);
    expect(card?.cursor).toBe(3);
    expect(card?.options.map((o) => o.answerKeys)).toEqual([`${UP}${UP}\r`, `${UP}\r`, "\r"]);

    // On the free-text row the highlight is on no option the card offers.
    const onOther = (await rowsAt(ASK, ASK.marks.askOpen)).map((row) =>
      row.replace(" ❯ red", "   red").replace("   Other (type", " ❯ Other (type"),
    );
    const other = detectCopilotCard(onOther);
    expect(other?.cursor).toBeUndefined();
    expect(other?.options.map((o) => o.answerKeys)).toEqual([
      `${UP}${UP}${UP}\r`,
      `${UP}${UP}\r`,
      `${UP}\r`,
    ]);
  });

  it("joins an option label that wraps onto a second row", async () => {
    const rows = await rowsAt(GATE, GATE.marks.gateOpen);
    const at = rows.findIndex((row) => row.includes("2. Yes, and don't ask again"));
    const box = (text: string) => `│ ${text.padEnd(116)} │`;
    rows.splice(
      at,
      1,
      box("  2. Yes, and don't ask again for `touch` in this directory"),
      box("     (/private/tmp/tb-capture-copilot-gate)"),
    );
    expect(detectCopilotCard(rows)?.options[1]).toEqual({
      index: 2,
      label:
        "Yes, and don't ask again for `touch` in this directory (/private/tmp/tb-capture-copilot-gate)",
      answerKeys: `${DOWN}\r`,
    });
  });

  it("builds a numbered card's keys from wherever the highlight is", async () => {
    const rows = (await rowsAt(GATE, GATE.marks.gateOpen)).map((row) =>
      row.replace("❯ 1. Yes", "  1. Yes").replace("  2. Yes, and", "❯ 2. Yes, and"),
    );
    const card = detectCopilotCard(rows);
    expect(card?.cursor).toBe(2);
    expect(card?.options.map((o) => o.answerKeys)).toEqual([`${UP}\r`, "\r", `${DOWN}\r`]);
  });

  it("sees no card while idle, mid-turn, or once a card is answered", async () => {
    expect(detectCopilotCard(await rowsAt(TURN, TURN.marks.ready))).toBeNull();
    expect(detectCopilotCard(await rowsAt(TURN, TURN.submitAt + 1_000))).toBeNull();
    expect(detectCopilotCard(await rowsAt(TURN, TURN.marks.settled))).toBeNull();
    expect(detectCopilotCard(await rowsAt(GATE, GATE.marks.gateAnswered + 500))).toBeNull();
    expect(detectCopilotCard(await rowsAt(GATE, GATE.marks.settled))).toBeNull();
    expect(detectCopilotCard(await rowsAt(ASK, ASK.marks.settled))).toBeNull();
  });

  it("ignores a numbered list and a footer quoted in a reply", () => {
    const rows = [
      " ● Pick one:",
      "   1. Yes",
      "   2. No",
      " ↑/↓ to navigate · enter to select · esc to cancel",
      "",
      "────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────",
      " ← open sidebar · Interactive · Manual Approval",
    ];
    expect(detectCopilotCard(rows)).toBeNull();
  });

  it("returns nothing for a card whose options have not all painted", async () => {
    const rows = await rowsAt(GATE, GATE.marks.gateOpen);
    const partial = rows.filter((row) => !row.includes("❯ 1. Yes"));
    expect(detectCopilotCard(partial)).toBeNull();
  });
});
