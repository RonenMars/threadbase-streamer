import { randomUUID } from "node:crypto";
import {
  PROMPT_SCHEMA_VERSION,
  type Prompt,
  type PromptAnswer,
  type PromptOption,
  type PromptQuestion,
  PromptSchema,
} from "../../schemas/prompt.schema";

export const PROMPT_TERMINAL_RETENTION_MS = 10 * 60 * 1000;
export const PROMPT_MAX_RECORDS_PER_SESSION = 200;

type PromptTerminalState = Extract<
  Prompt["state"],
  "resolved" | "cancelled" | "expired" | "unavailable"
>;

export type PromptOptionDraft = Omit<PromptOption, "optionId">;
export type PromptQuestionDraft = Omit<PromptQuestion, "questionId" | "options"> & {
  options: PromptOptionDraft[];
};
export type PromptDraft = Omit<
  Prompt,
  "schemaVersion" | "promptId" | "revision" | "state" | "terminalReason" | "questions"
> & {
  questions: PromptQuestionDraft[];
};

export type PromptAnswerErrorCode =
  | "prompt_not_found"
  | "prompt_revision_mismatch"
  | "already_resolved"
  | "prompt_expired"
  | "prompt_cancelled"
  | "prompt_unavailable"
  | "unknown_question"
  | "unknown_option"
  | "incomplete_answer"
  | "unsupported_prompt_shape"
  | "provider_error";

export type PromptAnswerOutcome =
  | { ok: true; prompt: Prompt }
  | {
      ok: false;
      code: PromptAnswerErrorCode;
      currentRevision?: number;
    };

export type PromptAdapterResult =
  | { ok: true }
  | {
      ok: false;
      code: PromptAnswerErrorCode;
      terminal?: { state: PromptTerminalState; reason: string };
    };

export type PromptAnswerAdapter = (context: {
  prompt: Prompt;
  answer: PromptAnswer;
}) => PromptAdapterResult | Promise<PromptAdapterResult>;

export interface PromptEvent {
  type: "prompt_event";
  sessionId: string;
  sequence: number;
  prompt: Prompt;
}

export interface PromptSnapshot {
  type: "prompt_snapshot";
  schemaVersion: typeof PROMPT_SCHEMA_VERSION;
  sessionId: string;
  sequence: number;
  prompts: Prompt[];
}

interface RecordedOutcome {
  at: number;
  outcome: PromptAnswerOutcome;
}

interface PromptEntry {
  prompt: Prompt;
  adapter?: PromptAnswerAdapter;
  terminalAt?: number;
  queue: Promise<void>;
  inFlight: Map<string, Promise<PromptAnswerOutcome>>;
  outcomes: Map<string, RecordedOutcome>;
}

export interface PromptRegistryOptions {
  createId?: () => string;
  emit?: (event: PromptEvent) => void;
  now?: () => number;
  terminalRetentionMs?: number;
  maxRecordsPerSession?: number;
}

function copyPrompt(prompt: Prompt): Prompt {
  return {
    ...prompt,
    questions: prompt.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    provenance: { ...prompt.provenance },
  };
}

function terminalError(state: PromptTerminalState): PromptAnswerErrorCode {
  switch (state) {
    case "resolved":
      return "already_resolved";
    case "expired":
      return "prompt_expired";
    case "cancelled":
      return "prompt_cancelled";
    case "unavailable":
      return "prompt_unavailable";
  }
}

export class PromptRegistry {
  private readonly bySession = new Map<string, Map<string, PromptEntry>>();
  private readonly byId = new Map<string, PromptEntry>();
  private readonly sequences = new Map<string, number>();
  private readonly createId: () => string;
  private readonly emit?: (event: PromptEvent) => void;
  private readonly now: () => number;
  private readonly terminalRetentionMs: number;
  private readonly maxRecordsPerSession: number;

  constructor(options: PromptRegistryOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.terminalRetentionMs = options.terminalRetentionMs ?? PROMPT_TERMINAL_RETENTION_MS;
    this.maxRecordsPerSession = options.maxRecordsPerSession ?? PROMPT_MAX_RECORDS_PER_SESSION;
  }

  open(draft: PromptDraft, adapter?: PromptAnswerAdapter, promptId = this.createId()): Prompt {
    this.prune(draft.sessionId);
    if (this.byId.has(promptId)) throw new Error(`Prompt id already exists: ${promptId}`);
    const prompt = PromptSchema.parse({
      ...draft,
      schemaVersion: PROMPT_SCHEMA_VERSION,
      promptId,
      revision: 1,
      state: "open",
      questions: draft.questions.map((question) => ({
        ...question,
        questionId: this.createId(),
        options: question.options.map((option) => ({ ...option, optionId: this.createId() })),
      })),
      provenance: { ...draft.provenance },
    });
    const entry: PromptEntry = {
      prompt,
      adapter,
      queue: Promise.resolve(),
      inFlight: new Map(),
      outcomes: new Map(),
    };
    const session = this.bySession.get(prompt.sessionId) ?? new Map<string, PromptEntry>();
    session.set(prompt.promptId, entry);
    this.bySession.set(prompt.sessionId, session);
    this.byId.set(prompt.promptId, entry);
    this.publish(entry);
    this.enforceCap(prompt.sessionId);
    return copyPrompt(prompt);
  }

  update(promptId: string, draft: PromptDraft, adapter?: PromptAnswerAdapter): Prompt {
    const entry = this.requireEntry(promptId);
    if (entry.prompt.sessionId !== draft.sessionId) throw new Error("Prompt session cannot change");
    if (entry.prompt.state !== "open" && entry.prompt.state !== "updated") {
      throw new Error(`Cannot update terminal prompt ${promptId}`);
    }
    if (entry.prompt.questions.length !== draft.questions.length) {
      throw new Error("Prompt question cardinality cannot change during an update");
    }
    const questions = draft.questions.map((question, questionIndex): PromptQuestion => {
      const prior = entry.prompt.questions[questionIndex];
      if (prior.options.length !== question.options.length) {
        throw new Error("Prompt option cardinality cannot change during an update");
      }
      return {
        ...question,
        questionId: prior.questionId,
        options: question.options.map((option, optionIndex) => ({
          ...option,
          optionId: prior.options[optionIndex].optionId,
        })),
      };
    });
    const prompt = PromptSchema.parse({
      ...draft,
      schemaVersion: PROMPT_SCHEMA_VERSION,
      promptId,
      revision: entry.prompt.revision + 1,
      state: "updated",
      questions,
      provenance: { ...draft.provenance },
    });
    entry.prompt = prompt;
    if (adapter) entry.adapter = adapter;
    this.publish(entry);
    return copyPrompt(entry.prompt);
  }

  transition(promptId: string, state: PromptTerminalState, reason: string): Prompt {
    const entry = this.requireEntry(promptId);
    if (entry.prompt.state !== "open" && entry.prompt.state !== "updated") {
      throw new Error(`Cannot transition terminal prompt ${promptId}`);
    }
    entry.prompt = {
      ...entry.prompt,
      revision: entry.prompt.revision + 1,
      state,
      terminalReason: reason,
    };
    entry.terminalAt = this.now();
    this.publish(entry);
    return copyPrompt(entry.prompt);
  }

  invalidateSession(sessionId: string, reason = "session_ended"): Prompt[] {
    const transitioned: Prompt[] = [];
    for (const entry of this.bySession.get(sessionId)?.values() ?? []) {
      if (entry.prompt.state === "open" || entry.prompt.state === "updated") {
        transitioned.push(this.transition(entry.prompt.promptId, "unavailable", reason));
      }
    }
    return transitioned;
  }

  get(promptId: string): Prompt | null {
    const entry = this.byId.get(promptId);
    if (!entry) return null;
    this.prune(entry.prompt.sessionId);
    return this.byId.has(promptId) ? copyPrompt(entry.prompt) : null;
  }

  hasActionable(sessionId: string): boolean {
    this.prune(sessionId);
    return [...(this.bySession.get(sessionId)?.values() ?? [])].some(
      (entry) => entry.prompt.state === "open" || entry.prompt.state === "updated",
    );
  }

  snapshot(sessionId: string): PromptSnapshot {
    this.prune(sessionId);
    return {
      type: "prompt_snapshot",
      schemaVersion: PROMPT_SCHEMA_VERSION,
      sessionId,
      sequence: this.sequences.get(sessionId) ?? 0,
      prompts: [...(this.bySession.get(sessionId)?.values() ?? [])].map((entry) =>
        copyPrompt(entry.prompt),
      ),
    };
  }

  answer(sessionId: string, answer: PromptAnswer): Promise<PromptAnswerOutcome> {
    this.prune(sessionId);
    const entry = this.byId.get(answer.promptId);
    if (!entry || entry.prompt.sessionId !== sessionId) {
      return Promise.resolve({ ok: false, code: "prompt_not_found" });
    }
    this.pruneOutcomes(entry);
    const recorded = entry.outcomes.get(answer.idempotencyKey);
    if (recorded) return Promise.resolve(recorded.outcome);
    const pending = entry.inFlight.get(answer.idempotencyKey);
    if (pending) return pending;

    const task = entry.queue.then(() => this.performAnswer(entry, answer));
    entry.queue = task.then(
      () => undefined,
      () => undefined,
    );
    entry.inFlight.set(answer.idempotencyKey, task);
    void task.then((outcome) => {
      entry.inFlight.delete(answer.idempotencyKey);
      entry.outcomes.set(answer.idempotencyKey, { at: this.now(), outcome });
    });
    return task;
  }

  private async performAnswer(
    entry: PromptEntry,
    answer: PromptAnswer,
  ): Promise<PromptAnswerOutcome> {
    const prompt = entry.prompt;
    if (prompt.state !== "open" && prompt.state !== "updated") {
      return { ok: false, code: terminalError(prompt.state) };
    }
    if (prompt.expiresAt !== null && this.now() >= Date.parse(prompt.expiresAt)) {
      this.transition(prompt.promptId, "expired", "deadline_elapsed");
      return { ok: false, code: "prompt_expired" };
    }
    if (prompt.revision !== answer.revision) {
      return {
        ok: false,
        code: "prompt_revision_mismatch",
        currentRevision: prompt.revision,
      };
    }
    const responseError = this.validateResponses(prompt, answer);
    if (responseError) return { ok: false, code: responseError };
    if (!entry.adapter) return { ok: false, code: "prompt_unavailable" };

    let adapterResult: PromptAdapterResult;
    try {
      adapterResult = await entry.adapter({ prompt: copyPrompt(prompt), answer });
    } catch {
      return { ok: false, code: "provider_error" };
    }
    if (entry.prompt.state !== "open" && entry.prompt.state !== "updated") {
      return { ok: false, code: terminalError(entry.prompt.state) };
    }
    if (entry.prompt.revision !== answer.revision) {
      return {
        ok: false,
        code: "prompt_revision_mismatch",
        currentRevision: entry.prompt.revision,
      };
    }
    if (!adapterResult.ok) {
      if (adapterResult.terminal) {
        this.transition(
          prompt.promptId,
          adapterResult.terminal.state,
          adapterResult.terminal.reason,
        );
      }
      return { ok: false, code: adapterResult.code };
    }
    return { ok: true, prompt: this.transition(prompt.promptId, "resolved", "answered") };
  }

  private validateResponses(prompt: Prompt, answer: PromptAnswer): PromptAnswerErrorCode | null {
    const questions = new Map(prompt.questions.map((question) => [question.questionId, question]));
    for (const response of answer.responses) {
      if (!questions.has(response.questionId)) return "unknown_question";
    }
    if (answer.responses.length !== prompt.questions.length) return "incomplete_answer";

    const responses = new Map(answer.responses.map((response) => [response.questionId, response]));
    for (const question of prompt.questions) {
      const response = responses.get(question.questionId);
      if (!response) return "incomplete_answer";
      if (question.inputMode === "text") {
        if (typeof response.text !== "string") return "incomplete_answer";
        continue;
      }
      const optionIds = response.optionIds;
      if (!optionIds) return "incomplete_answer";
      if (question.inputMode === "single" && optionIds.length !== 1) {
        return "unsupported_prompt_shape";
      }
      const known = new Set(question.options.map((option) => option.optionId));
      if (optionIds.some((optionId) => !known.has(optionId))) return "unknown_option";
    }
    return null;
  }

  private publish(entry: PromptEntry): void {
    const sessionId = entry.prompt.sessionId;
    const sequence = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, sequence);
    this.emit?.({
      type: "prompt_event",
      sessionId,
      sequence,
      prompt: copyPrompt(entry.prompt),
    });
  }

  private requireEntry(promptId: string): PromptEntry {
    const entry = this.byId.get(promptId);
    if (!entry) throw new Error(`Unknown prompt: ${promptId}`);
    return entry;
  }

  private prune(sessionId: string): void {
    const now = this.now();
    const session = this.bySession.get(sessionId);
    if (!session) return;
    for (const [promptId, entry] of session) {
      if (entry.terminalAt !== undefined && now - entry.terminalAt > this.terminalRetentionMs) {
        session.delete(promptId);
        this.byId.delete(promptId);
      }
    }
    if (session.size === 0) this.bySession.delete(sessionId);
  }

  private enforceCap(sessionId: string): void {
    const session = this.bySession.get(sessionId);
    if (!session || session.size <= this.maxRecordsPerSession) return;
    const terminal = [...session.entries()]
      .filter(([, entry]) => entry.terminalAt !== undefined)
      .sort((a, b) => (a[1].terminalAt ?? 0) - (b[1].terminalAt ?? 0));
    while (session.size > this.maxRecordsPerSession && terminal.length > 0) {
      const [promptId] = terminal.shift() as [string, PromptEntry];
      session.delete(promptId);
      this.byId.delete(promptId);
    }
  }

  private pruneOutcomes(entry: PromptEntry): void {
    const now = this.now();
    for (const [key, recorded] of entry.outcomes) {
      if (now - recorded.at > this.terminalRetentionMs) entry.outcomes.delete(key);
    }
  }
}
