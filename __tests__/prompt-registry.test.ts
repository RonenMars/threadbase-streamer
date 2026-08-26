import type { PromptAnswer } from "../src/schemas/prompt.schema";
import {
  type PromptAnswerAdapter,
  type PromptDraft,
  PromptRegistry,
} from "../src/services/prompts/promptRegistry";

function ids(): () => string {
  const values = [
    "prompt-1",
    "question-1",
    "option-a",
    "option-b",
    "prompt-2",
    "question-2",
    "option-c",
    "option-d",
  ];
  return () => values.shift() ?? "extra-id";
}

function draft(message = "Choose one"): PromptDraft {
  return {
    sessionId: "session-1",
    intent: "question",
    message,
    questions: [
      {
        text: message,
        header: "Choice",
        inputMode: "single",
        options: [{ label: "A" }, { label: "B" }],
        allowOther: false,
        secret: "unknown",
      },
    ],
    answerRequirement: "unknown",
    expiresAt: null,
    provenance: { source: "screen", confidence: "inferred" },
  };
}

function answer(
  promptId: string,
  revision: number,
  idempotencyKey: string,
  optionId = "option-a",
): PromptAnswer {
  return {
    promptId,
    revision,
    responses: [{ questionId: "question-1", optionIds: [optionId] }],
    idempotencyKey,
  };
}

describe("PromptRegistry lifecycle", () => {
  it("rejects a draft that cannot produce a valid public prompt", () => {
    const registry = new PromptRegistry({ createId: ids() });

    expect(() =>
      registry.open({
        ...draft(),
        questions: [{ ...draft().questions[0], options: [] }],
      }),
    ).toThrow(/select questions require options/);
    expect(registry.snapshot("session-1").prompts).toEqual([]);
  });

  it("keeps multiple prompts and emits monotonic per-session sequence numbers", () => {
    const events: Array<{ sequence: number; promptId: string }> = [];
    const registry = new PromptRegistry({
      createId: ids(),
      emit: (event) => events.push({ sequence: event.sequence, promptId: event.prompt.promptId }),
    });

    const first = registry.open(draft("First"));
    const second = registry.open(draft("Second"));
    const snapshot = registry.snapshot("session-1");

    expect(first.promptId).toBe("prompt-1");
    expect(second.promptId).toBe("prompt-2");
    expect(snapshot.sequence).toBe(2);
    expect(snapshot.prompts.map((prompt) => prompt.promptId)).toEqual(["prompt-1", "prompt-2"]);
    expect(events).toEqual([
      { sequence: 1, promptId: "prompt-1" },
      { sequence: 2, promptId: "prompt-2" },
    ]);
  });

  it("preserves opaque ids and increments revision on a meaningful update", () => {
    const registry = new PromptRegistry({ createId: ids() });
    const opened = registry.open(draft());
    const updated = registry.update(opened.promptId, {
      ...draft(),
      detail: "Authoritative transcript detail",
      provenance: { source: "transcript", confidence: "authoritative" },
    });

    expect(updated.state).toBe("updated");
    expect(updated.revision).toBe(2);
    expect(updated.promptId).toBe(opened.promptId);
    expect(updated.questions[0].questionId).toBe(opened.questions[0].questionId);
    expect(updated.questions[0].options.map((option) => option.optionId)).toEqual(
      opened.questions[0].options.map((option) => option.optionId),
    );
    expect(registry.snapshot("session-1").sequence).toBe(2);
  });

  it("rejects an invalid update without changing the current prompt", () => {
    const registry = new PromptRegistry({ createId: ids() });
    const opened = registry.open(draft());

    expect(() => registry.update(opened.promptId, draft("   "))).toThrow(
      /prompt requires a meaningful title, message, or detail|Too small/,
    );
    expect(registry.get(opened.promptId)).toEqual(opened);
    expect(registry.snapshot("session-1").sequence).toBe(1);
  });

  it("makes terminal states immutable", () => {
    const registry = new PromptRegistry({ createId: ids() });
    const opened = registry.open(draft());
    const cancelled = registry.transition(opened.promptId, "cancelled", "provider_closed");

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.revision).toBe(2);
    expect(() => registry.transition(opened.promptId, "resolved", "answered")).toThrow(
      /terminal prompt/,
    );
  });

  it("prunes retained terminal prompts after the configured window", () => {
    let now = 1_000;
    const registry = new PromptRegistry({
      createId: ids(),
      now: () => now,
      terminalRetentionMs: 100,
    });
    const opened = registry.open(draft());
    registry.transition(opened.promptId, "unavailable", "session_ended");

    now = 1_101;

    expect(registry.snapshot("session-1").prompts).toEqual([]);
  });
});

describe("PromptRegistry atomic answers", () => {
  it("rejects a stale revision before calling the provider adapter", async () => {
    let writes = 0;
    const adapter: PromptAnswerAdapter = async () => {
      writes += 1;
      return { ok: true };
    };
    const registry = new PromptRegistry({ createId: ids() });
    const opened = registry.open(draft(), adapter);
    registry.update(opened.promptId, draft(), adapter);

    const result = await registry.answer("session-1", answer(opened.promptId, 1, "stale"));

    expect(result).toEqual({
      ok: false,
      code: "prompt_revision_mismatch",
      currentRevision: 2,
    });
    expect(writes).toBe(0);
  });

  it("serializes different-key races so exactly one provider response occurs", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const adapter: PromptAnswerAdapter = async () => {
      writes += 1;
      await blocked;
      return { ok: true };
    };
    const registry = new PromptRegistry({ createId: ids() });
    const opened = registry.open(draft(), adapter);

    const first = registry.answer("session-1", answer(opened.promptId, 1, "client-a"));
    const second = registry.answer("session-1", answer(opened.promptId, 1, "client-b"));
    await Promise.resolve();
    release();
    const results = await Promise.all([first, second]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({
      ok: false,
      code: "already_resolved",
    });
    expect(writes).toBe(1);
    expect(registry.get(opened.promptId)?.state).toBe("resolved");
  });

  it("replays an in-flight same-key retry and writes once", async () => {
    let writes = 0;
    const registry = new PromptRegistry({ createId: ids() });
    const opened = registry.open(draft(), async () => {
      writes += 1;
      return { ok: true };
    });

    const [first, retry] = await Promise.all([
      registry.answer("session-1", answer(opened.promptId, 1, "same-key")),
      registry.answer("session-1", answer(opened.promptId, 1, "same-key")),
    ]);

    expect(first).toEqual(retry);
    expect(first.ok).toBe(true);
    expect(writes).toBe(1);
  });

  it("preserves an external terminal transition while an answer is in flight", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new PromptRegistry({ createId: ids() });
    const opened = registry.open(draft(), async () => {
      await blocked;
      return { ok: true };
    });

    const pending = registry.answer("session-1", answer(opened.promptId, 1, "interrupted"));
    await Promise.resolve();
    registry.transition(opened.promptId, "cancelled", "provider_closed");
    release();

    await expect(pending).resolves.toEqual({ ok: false, code: "prompt_cancelled" });
    expect(registry.get(opened.promptId)?.state).toBe("cancelled");
  });

  it("rejects incomplete and unknown option answers before the adapter", async () => {
    let writes = 0;
    const registry = new PromptRegistry({ createId: ids() });
    const opened = registry.open(draft(), async () => {
      writes += 1;
      return { ok: true };
    });

    const incomplete = await registry.answer("session-1", {
      ...answer(opened.promptId, 1, "missing"),
      responses: [],
    });
    const unknown = await registry.answer(
      "session-1",
      answer(opened.promptId, 1, "unknown", "not-an-option"),
    );

    expect(incomplete).toEqual({ ok: false, code: "incomplete_answer" });
    expect(unknown).toEqual({ ok: false, code: "unknown_option" });
    expect(writes).toBe(0);
  });
});
