// Phase 7b: the one-time question behind auto-resume on boot.
//
// The property worth pinning is that only an explicit yes enables it. This is
// the single setting that lets the streamer start an agent nobody asked for in
// that moment, and with a bypass permission mode that is unattended arbitrary
// code execution — so every ambiguous input must fall to `false`.

import { afterEach, describe, expect, it, vi } from "vitest";

const question = vi.fn();
const write = vi.fn();
const close = vi.fn();

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question, close }),
}));

vi.mock("node:process", () => ({
  stdin: {},
  stdout: { write },
}));

afterEach(() => {
  question.mockReset();
  write.mockReset();
  close.mockReset();
});

async function ask(answer: string): Promise<boolean> {
  question.mockResolvedValue(answer);
  const { interactiveAutoResumePrompt } = await import("../src/lifecycle/prompt");
  return interactiveAutoResumePrompt();
}

describe("interactiveAutoResumePrompt", () => {
  it("enables only on an explicit yes", async () => {
    expect(await ask("y")).toBe(true);
    expect(await ask("yes")).toBe(true);
    expect(await ask("Y")).toBe(true);
    expect(await ask("  YES  ")).toBe(true);
  });

  it("defaults to no on an empty line", async () => {
    // Silence must never enable it.
    expect(await ask("")).toBe(false);
  });

  it("treats anything else as no, including a near-miss", async () => {
    for (const answer of ["n", "no", "yep", "sure", "1", "true", "ok"]) {
      expect(await ask(answer)).toBe(false);
    }
  });

  it("states the consequence in the prompt, not just the options", async () => {
    await ask("n");
    const shown = write.mock.calls.map((c) => c[0]).join("");
    // Someone answering this needs to know what yes actually means; a bare
    // y/N would be asking for consent to something unexplained.
    expect(shown).toContain("agents can start without you present");
    expect(shown).toContain("default");
  });

  it("closes the readline interface even when the question rejects", async () => {
    question.mockRejectedValue(new Error("stdin closed"));
    const { interactiveAutoResumePrompt } = await import("../src/lifecycle/prompt");

    await expect(interactiveAutoResumePrompt()).rejects.toThrow("stdin closed");
    // A leaked interface holds stdin open and hangs the boot.
    expect(close).toHaveBeenCalled();
  });
});
