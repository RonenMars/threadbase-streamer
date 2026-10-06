// What Copilot CLI and Cursor paint for a turn and for each question they ask,
// pinned from raw PTY captures recorded by `scripts/capture-pty.ts` (each
// fixture carries its own `scenario`). Neither provider had a raw capture of a
// question before these, and Copilot had none at all.
//
// These assert properties of the CLIs, not of the runners: a recapture on a
// newer build that loses one fails here, where the reason is legible, rather
// than as a detector that silently stops matching.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { createScreen, PTY_ROWS } from "../src/pty-shared";

interface Capture {
  submitAt: number;
  marks: Record<string, number>;
  chunks: [number, string][];
}

const DIR = join(__dirname, "fixtures", "turn-signals");
const load = (name: string): Capture => JSON.parse(readFileSync(join(DIR, name), "utf8"));

/** The rendered screen once every chunk up to and including `ms` is written. */
async function screenAt(cap: Capture, ms: number): Promise<string> {
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
  return rows.join("\n");
}

const chunksBetween = (cap: Capture, from: number, to: number) =>
  cap.chunks.filter(([ms]) => ms > from && ms < to);

describe("Copilot CLI 1.0.92 captures (pins)", () => {
  const TURN = load("copilot-1.0.92-turn.json");
  const GATE = load("copilot-1.0.92-gate.json");
  const ASK = load("copilot-1.0.92-ask.json");
  const BUSY = "Working";
  const IDLE = "open sidebar";

  it("signals a turn in its status row, not in the terminal title", async () => {
    const ready = await screenAt(TURN, TURN.marks.ready);
    expect(ready).toContain(IDLE);
    expect(ready).not.toContain(BUSY);

    // Typed text swaps the idle footer for compose hints, so idle cannot be read
    // as "the idle footer is showing": only as "busy is not".
    const typed = await screenAt(TURN, TURN.submitAt);
    expect(typed).toContain("Manual Approval · @ files");
    expect(typed).not.toContain(IDLE);
    expect(typed).not.toContain(BUSY);

    const mid = await screenAt(TURN, TURN.submitAt + 1_000);
    expect(mid).toContain(BUSY);
    expect(mid).not.toContain(IDLE);

    const end = await screenAt(TURN, TURN.marks.settled);
    expect(end).toContain(IDLE);
    expect(end).not.toContain(BUSY);

    // The title only ever names the session: no spinner or idle glyph to read.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal OSC escapes
    const titles = TURN.chunks.flatMap(([, d]) => [...d.matchAll(/\x1b\]0;([^\x07]*)\x07/g)]);
    expect(titles.length).toBeGreaterThan(1);
    expect(titles.every((m) => m[1].endsWith("GitHub Copilot"))).toBe(true);
  });

  it("asks for folder trust in a boxed numbered card before the session is ready", async () => {
    const card = await screenAt(TURN, TURN.marks.trustOpen);
    expect(card).toContain("Do you trust the files in this folder?");
    expect(card).toContain("❯ 1. Yes");
    expect(card).toContain("3. No (Esc)");
    expect(card).toContain("↑/↓ to navigate · enter to select · esc to cancel");
    expect(card).not.toContain(IDLE);
  });

  it("replaces the status row with the permission card, so busy is not on screen", async () => {
    const card = await screenAt(GATE, GATE.marks.gateOpen);
    expect(card).toContain("Do you want to run this command?");
    expect(card).toContain("❯ 1. Yes");
    expect(card).toContain("↑/↓ to navigate · enter to select · esc to cancel");
    expect(card).not.toContain(BUSY);
    expect(card).not.toContain(IDLE);

    // Once answered the same turn carries on, busy again, then ends.
    expect(await screenAt(GATE, GATE.marks.gateAnswered + 500)).toContain(BUSY);
    expect(await screenAt(GATE, GATE.marks.settled)).toContain(IDLE);
  });

  it("draws an ask_user form unboxed, with its own header and footer", async () => {
    const form = await screenAt(ASK, ASK.marks.askOpen);
    expect(form).toContain("Copilot needs information.");
    expect(form).toContain("Other (type your answer)");
    expect(form).toContain("enter accept · ctrl+d decline · esc cancel");
    expect(form).not.toContain("enter to select");
    expect(form).not.toContain(BUSY);
    expect(form).not.toContain(IDLE);
  });
});

describe("Cursor 2026.10.01 captures (pins)", () => {
  const TURN = load("cursor-2026.10.01-turn.json");
  const ASK = load("cursor-2026.10.01-ask.json");
  const TRUST = load("cursor-2026.10.01-trust.json");
  const BUSY = "ctrl+c to stop";

  it("still shows its busy hint for the turn and drops it at the end", async () => {
    expect(await screenAt(TURN, TURN.submitAt)).not.toContain(BUSY);
    expect(await screenAt(TURN, TURN.submitAt + 1_000)).toContain(BUSY);
    expect(await screenAt(TURN, TURN.marks.settled)).not.toContain(BUSY);
  });

  it("drops the busy hint and goes silent while a question card is open", async () => {
    // The card title is the model's own wording (the same prompt has produced
    // "Clarifying Questions" and "Color choice"), so only the counter and the
    // footer identify the card.
    const card = await screenAt(ASK, ASK.marks.askOpen);
    expect(card).toContain("Question 1 of 1");
    expect(card).toContain("› [ ] red");
    expect(card).toContain("Space select · Enter next/submit · Esc to skip");
    // The turn is not over, yet nothing on screen says the agent is busy and
    // nothing is painted until the answer arrives.
    expect(card).not.toContain(BUSY);
    expect(chunksBetween(ASK, ASK.marks.askOpen, ASK.marks.askAnswered)).toEqual([]);

    // The answer resumes the same turn.
    expect(await screenAt(ASK, ASK.marks.askAnswered + 2_000)).toContain(BUSY);
    expect(await screenAt(ASK, ASK.marks.settled)).not.toContain(BUSY);
  });

  it("asks for workspace trust with lettered options when --trust is absent", async () => {
    const card = await screenAt(TRUST, TRUST.marks.trustOpen);
    expect(card).toContain("Workspace Trust Required");
    expect(card).toContain("▶ [a] Trust this workspace");
    expect(card).toContain("[q] Quit");
  });
});

describe("turn-signal fixtures are safe to publish", () => {
  it("carry no home directory or email address", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(join(DIR, file), "utf8");
      expect(
        text.match(/\/(?:Users|home)\/[\w.-]+|[\w.+-]+@[\w-]+\.[a-z]{2,}/i)?.[0],
        file,
      ).toBeUndefined();
    }
  });
});
