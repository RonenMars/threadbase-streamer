import { EventEmitter } from "events";
import { mkdtempSync } from "fs";
import { spawn as mockSpawn } from "node-pty";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import type { AskQuestion, PermissionOption } from "../src/types";

/**
 * Codex answers every prompt it can card over the PERMISSION transport, and
 * never over onLiveQuestion — Claude's AskUserQuestion channel. `CodexPtyRunner`
 * used to hold both callbacks as private fields and call neither, which read as
 * a half-wired feature rather than a deliberate choice.
 *
 * The distinction is the answer encoding. AskUserQuestion is answered
 * positionally (answersToKeystrokes emits N down-arrows then Enter), so it
 * cannot express "send the digit 3" or "send y". Codex prompts are answered by
 * literal bytes the detector supplies. `capabilities.ts` says the same thing in
 * its own vocabulary: Codex is `structuredQuestions: false`.
 *
 * These tests fail if someone wires onLiveQuestion into CodexPtyRunner, which
 * is the point — the encoding mismatch has to be confronted, not rediscovered.
 *
 * The literal-bytes half of that claim is already covered by
 * codex-pty-runner.test.ts "parses numbered menu options"; it is not repeated
 * here so the two cannot drift.
 */

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 54321,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

interface MockProc {
  _emit: (event: string, data: unknown) => void;
}

function getMockProc(runner: CodexPtyRunner, sessionId: string): MockProc {
  const internals = runner as unknown as {
    sessions: Map<string, { process: MockProc }>;
  };
  const entry = internals.sessions.get(sessionId);
  if (!entry) throw new Error(`No mock process for ${sessionId}`);
  return entry.process;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A real rendered screen — the "Approaching rate limits" model picker, three
// options, each answered by its own digit. Captured in codex-pty-runner.test.ts.
const RATE_LIMIT_SCREEN =
  "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage " +
  "or try again at Aug 8th, 2026 10:18 AM.\r\n" +
  "\r\n" +
  "Approaching rate limits\r\n" +
  "› 1. Switch to gpt-5.6-luna (selected)\r\n" +
  "  Fast and affordable agentic coding model.\r\n" +
  "  2. Keep current model.\r\n" +
  "  3. Keep current model (never show again).\r\n";

// The directory-trust gate, the other multi-option Codex prompt.
const TRUST_GATE_SCREEN =
  "Do you want to trust the contents of this directory?\r\n" +
  "1. Yes, continue\r\n" +
  "2. No, quit\r\n" +
  "Press enter to continue\r\n";

function runnerWithBothChannels() {
  const permissions: Array<{ options: PermissionOption[] } | null> = [];
  const liveQuestions: AskQuestion[][] = [];
  let liveQuestionGoneCalls = 0;

  const runner = new CodexPtyRunner({
    onPermissionChange: (_sessionId, gate) =>
      permissions.push(gate as { options: PermissionOption[] } | null),
    onLiveQuestion: (_sessionId, questions) => liveQuestions.push(questions),
    onLiveQuestionGone: () => {
      liveQuestionGoneCalls += 1;
    },
  });

  return { runner, permissions, liveQuestions, getGoneCalls: () => liveQuestionGoneCalls };
}

async function spawnFresh(runner: CodexPtyRunner) {
  return runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
}

// The trust gate is only carded when it has not already been answered, and
// `rememberedGateDigit` resolves the config dir at call time — so without this
// the runner reads the developer's real ~/.threadbase/gate-answers.json, finds
// `{"codexTrustGate":"yes"}`, auto-answers, and the card never fires. That makes
// the test pass or fail depending on whose machine runs it.
let configDirBefore: string | undefined;
beforeEach(() => {
  configDirBefore = process.env.THREADBASE_CONFIG_DIR;
  process.env.THREADBASE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tb-codex-transport-"));
  vi.mocked(mockSpawn).mockClear();
});
afterEach(() => {
  if (configDirBefore === undefined) delete process.env.THREADBASE_CONFIG_DIR;
  else process.env.THREADBASE_CONFIG_DIR = configDirBefore;
});

describe("CodexPtyRunner routes prompts over permission, never over live-question", () => {
  it("cards the multi-option rate-limit picker over onPermissionChange", async () => {
    const { runner, permissions, liveQuestions, getGoneCalls } = runnerWithBothChannels();
    const session = await spawnFresh(runner);

    getMockProc(runner, session.id)._emit("data", RATE_LIMIT_SCREEN);
    await tick();

    const carded = permissions.filter((p): p is { options: PermissionOption[] } => p !== null);
    expect(carded.length).toBeGreaterThan(0);
    expect(carded.at(-1)?.options.length).toBeGreaterThanOrEqual(3);

    // Both live-question channels stay silent even though this IS a genuine
    // multi-choice menu — the case someone would reach for onLiveQuestion for.
    expect(liveQuestions).toEqual([]);
    expect(getGoneCalls()).toBe(0);
  });

  it("cards the directory-trust gate over onPermissionChange, not live-question", async () => {
    const { runner, permissions, liveQuestions, getGoneCalls } = runnerWithBothChannels();
    const session = await spawnFresh(runner);

    getMockProc(runner, session.id)._emit("data", TRUST_GATE_SCREEN);
    await tick();

    expect(permissions.filter((p) => p !== null).length).toBeGreaterThan(0);
    expect(liveQuestions).toEqual([]);
    expect(getGoneCalls()).toBe(0);
  });

  it("never fires live-question for ordinary output either", async () => {
    const { runner, liveQuestions, getGoneCalls } = runnerWithBothChannels();
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", "gpt-5.5 medium · /path · Ready\r\n");
    await tick();
    proc._emit("data", "just some assistant prose, no menu here\r\n");
    await tick();

    expect(liveQuestions).toEqual([]);
    expect(getGoneCalls()).toBe(0);
  });
});
