// Composer suggestion through a live (fake) PTY: a real PTYManager scraping a
// real rendered screen and firing onPromptSuggestionChange. The detector's own
// unit tests cannot reach the trigger/throttle wiring, and every failure here is
// silent — a runner that never scans typechecks and reports no suggestion.

import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { InternalSession } from "../src/pty-shared";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 31338,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const RULE = "─".repeat(100);
// Whole-screen repaint of an idle composer, as Claude Code draws it.
const screen = (composer: string) =>
  `\x1b[2J\x1b[H⏺ done\r\n\x1b[35;1H${RULE}\r\n${composer}\r\n${RULE}\r\n  ⏵⏵ auto mode on\r\n`;
const IDLE = screen("❯ ");
// Bytes captured from Claude Code v2.1.278: the text sits inside ESC[2m … ESC[22m.
const SUGGESTED = screen("❯ \x1b[2madd type hints and a docstring\x1b[22m");
const TYPED = screen("❯ add type hints and a docstring");

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const until = performance.now() + budgetMs;
  while (performance.now() < until) {
    if (predicate()) return;
    await settle(5);
  }
}

describe("prompt suggestion — Claude turn through a fake PTY", () => {
  it("reports the suggestion once, and clears it when the user sends input", async () => {
    const seen: (string | null)[] = [];
    const runner = new PTYManager({ onPromptSuggestionChange: (_id, t) => seen.push(t) });
    try {
      const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
      const internal = (
        runner as unknown as { sessions: Map<string, InternalSession> }
      ).sessions.get(session.id) as InternalSession;
      const proc = internal.process as unknown as { _emit: (e: string, d: string) => void };

      proc._emit("data", IDLE);
      await waitUntil(() => runner.getSession(session.id)?.status === "waiting_input");
      expect(runner.getSession(session.id)?.status).toBe("waiting_input");
      expect(seen).toEqual([]);

      proc._emit("data", SUGGESTED);
      await waitUntil(() => seen.length >= 1);
      expect(seen).toEqual(["add type hints and a docstring"]);
      expect(runner.getSession(session.id)?.promptSuggestion).toBe(
        "add type hints and a docstring",
      );

      // A repaint of the same text is not a change: no second frame.
      proc._emit("data", SUGGESTED);
      await settle(400);
      expect(seen).toEqual(["add type hints and a docstring"]);

      runner.sendInput(session.id, "add type hints and a docstring");
      expect(seen).toEqual(["add type hints and a docstring", null]);
    } finally {
      runner.dispose();
    }
  }, 15000);

  // The suggestion is painted after the turn's last chunk, often inside the 300ms
  // scrape throttle of the previous pass, and a waiting_input session has no
  // quiet re-scan. The dim escape in the chunk must bypass the throttle.
  it("reports a suggestion painted inside the scrape throttle window", async () => {
    const seen: (string | null)[] = [];
    const runner = new PTYManager({ onPromptSuggestionChange: (_id, t) => seen.push(t) });
    try {
      const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
      const internal = (
        runner as unknown as { sessions: Map<string, InternalSession> }
      ).sessions.get(session.id) as InternalSession;
      const proc = internal.process as unknown as { _emit: (e: string, d: string) => void };
      proc._emit("data", IDLE);
      await waitUntil(() => runner.getSession(session.id)?.status === "waiting_input");
      // Let any scan still in flight from the IDLE chunk finish — it would read
      // the suggestion off the shared screen and mask the throttle.
      await settle(400);
      // Force a pass "just now", then paint the suggestion well inside the window.
      (runner as unknown as { lastDetectAt: Map<string, number> }).lastDetectAt.set(
        session.id,
        Date.now(),
      );
      proc._emit("data", SUGGESTED);
      await waitUntil(() => seen.length >= 1, 250);
      expect(seen).toEqual(["add type hints and a docstring"]);
    } finally {
      runner.dispose();
    }
  }, 15000);

  // Positive control for the test above: identical text, no dim flag, must stay silent.
  it("does not report text the user typed", async () => {
    const seen: (string | null)[] = [];
    const runner = new PTYManager({ onPromptSuggestionChange: (_id, t) => seen.push(t) });
    try {
      const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
      const internal = (
        runner as unknown as { sessions: Map<string, InternalSession> }
      ).sessions.get(session.id) as InternalSession;
      const proc = internal.process as unknown as { _emit: (e: string, d: string) => void };
      proc._emit("data", IDLE);
      await waitUntil(() => runner.getSession(session.id)?.status === "waiting_input");
      proc._emit("data", TYPED);
      await settle(400);
      expect(seen).toEqual([]);
    } finally {
      runner.dispose();
    }
  }, 15000);

  it("clears a shown suggestion when the composer is repainted without it", async () => {
    const seen: (string | null)[] = [];
    const runner = new PTYManager({ onPromptSuggestionChange: (_id, t) => seen.push(t) });
    try {
      const session = await runner.startFresh({ projectPath: "/tmp/test", projectName: "test" });
      const internal = (
        runner as unknown as { sessions: Map<string, InternalSession> }
      ).sessions.get(session.id) as InternalSession;
      const proc = internal.process as unknown as { _emit: (e: string, d: string) => void };
      proc._emit("data", IDLE);
      await waitUntil(() => runner.getSession(session.id)?.status === "waiting_input");
      proc._emit("data", SUGGESTED);
      await waitUntil(() => seen.length >= 1);
      proc._emit("data", TYPED);
      await waitUntil(() => seen.length >= 2);
      expect(seen).toEqual(["add type hints and a docstring", null]);
    } finally {
      runner.dispose();
    }
  }, 15000);
});
