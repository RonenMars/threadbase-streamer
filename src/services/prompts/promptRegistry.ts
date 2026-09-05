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
const MAX_TIMEOUT_MS = 2_147_483_647;

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

/**
 * Everything the registry still RETAINS for a session, not just what is
 * actionable: terminal records stay for PROMPT_TERMINAL_RETENTION_MS (capped at
 * PROMPT_MAX_RECORDS_PER_SESSION) so a reconnecting client can see how a prompt
 * it was showing ended. A subscriber therefore filters on `state` — presence in
 * a snapshot is not an open prompt.
 *
 * Retention also bounds idempotency: once a record is pruned, an answer retry
 * that would have replayed its recorded outcome gets `prompt_not_found`
 * instead (HTTP 404 on the answer route).
 */
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
  expiryTimer?: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  inFlight: Map<string, Promise<PromptAnswerOutcome>>;
  outcomes: Map<string, RecordedOutcome>;
  // Set only across a provider write, so a teardown observed during it can be
  // attributed to that write instead of read as the provider moving on.
  answering?: boolean;
  deferredClose?: string;
}

export interface PromptRegistryOptions {
  createId?: () => string;
  emit?: (event: PromptEvent) => void;
  onExpire?: (prompt: Prompt) => void;
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
  private readonly onExpire?: (prompt: Prompt) => void;
  private readonly now: () => number;
  private readonly terminalRetentionMs: number;
  private readonly maxRecordsPerSession: number;

  constructor(options: PromptRegistryOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.emit = options.emit;
    this.onExpire = options.onExpire;
    this.now = options.now ?? Date.now;
    this.terminalRetentionMs = options.terminalRetentionMs ?? PROMPT_TERMINAL_RETENTION_MS;
    this.maxRecordsPerSession = options.maxRecordsPerSession ?? PROMPT_MAX_RECORDS_PER_SESSION;
  }

  open(draft: PromptDraft, adapter?: PromptAnswerAdapter, promptId = this.createId()): Prompt {
    this.sweepExpired(draft.sessionId);
    const held = this.byId.get(promptId);
    if (held && (held.prompt.state === "open" || held.prompt.state === "updated")) {
      throw new Error(`Prompt id already exists: ${promptId}`);
    }
    // A RETAINED TERMINAL record under this id is a producer replay, not a
    // duplicate. The pty-host keeps one occurrence id for as long as its
    // detector sees the same content, while a streamer-side clear the host
    // never saw (gate_closed on the legacy answer route, a cancelled question)
    // leaves that id terminal here for PROMPT_TERMINAL_RETENTION_MS. The next
    // repaint of the same gate then arrives with an id we still hold — inside
    // a detector callback with no catch anywhere above it. Mint a fresh id and
    // open normally; the retained record stays readable under the old one.
    const id = held ? this.createId() : promptId;
    const prompt = PromptSchema.parse({
      ...draft,
      schemaVersion: PROMPT_SCHEMA_VERSION,
      promptId: id,
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
    this.scheduleExpiration(entry);
    this.enforceCap(prompt.sessionId);
    return copyPrompt(prompt);
  }

  update(promptId: string, draft: PromptDraft, adapter?: PromptAnswerAdapter): Prompt {
    const entry = this.requireEntry(promptId);
    this.expireIfDue(entry, this.now());
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
    this.scheduleExpiration(entry);
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
    this.clearExpiration(entry);
    this.publish(entry);
    return copyPrompt(entry.prompt);
  }

  /**
   * The provider's prompt left the screen.
   *
   * Distinct from `transition` because the detector cannot tell a teardown it
   * observed on its own from one OUR OWN write caused. On a screen-scraped gate
   * the answer keys remove the box, and pty-manager's sendKeys fires the close
   * synchronously from inside the write — so the close always arrives before
   * the answer that caused it has settled, and reporting it as a cancel failed
   * every answer whose bytes had already landed (#720).
   *
   * While an answer is writing, the close is deferred and the answer decides:
   * `resolved` if the write landed, the deferred close if it did not. Success
   * is the adapter's own result, never the prompt's absence from the screen —
   * a prompt that does not vanish when answered (a multi-select form) simply
   * never reaches here, and is settled by the same adapter result (#721).
   *
   * ONLY this path defers. `replaced` from a different gate taking the screen,
   * `unavailable` from invalidateSession and `expired` all still go through
   * `transition` and still win, because none of them was caused by our write.
   */
  providerClosed(promptId: string, reason: string): Prompt | null {
    const entry = this.byId.get(promptId);
    if (!entry) return null;
    if (entry.prompt.state !== "open" && entry.prompt.state !== "updated") return null;
    if (entry.answering) {
      entry.deferredClose = reason;
      return null;
    }
    return this.transition(promptId, "cancelled", reason);
  }

  /**
   * Run a provider write that may close the prompt as a side effect, so the
   * close it causes is deferred rather than applied. For callers outside this
   * class that write without going through `answer()` — the legacy permission
   * route. `performAnswer` manages the same two fields directly, because it
   * needs the deferred value in its own control flow.
   *
   * The write's own failure needs no unwinding here: pty-manager fires the
   * close as the last statement of a successful sendKeys, so a throw means no
   * close was ever deferred and the record is still open for the caller.
   */
  whileAnswering<T>(promptId: string, write: () => T): T {
    const entry = this.byId.get(promptId);
    if (!entry) return write();
    entry.answering = true;
    try {
      return write();
    } finally {
      entry.answering = false;
      entry.deferredClose = undefined;
    }
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
    this.sweepExpired(entry.prompt.sessionId);
    return this.byId.has(promptId) ? copyPrompt(entry.prompt) : null;
  }

  snapshot(sessionId: string): PromptSnapshot {
    this.sweepExpired(sessionId);
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

  dispose(): void {
    for (const entry of this.byId.values()) this.clearExpiration(entry);
  }

  answer(sessionId: string, answer: PromptAnswer): Promise<PromptAnswerOutcome> {
    this.sweepExpired(sessionId);
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
    if (this.expireIfDue(entry, this.now())) {
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

    // Marked HERE: after every pre-adapter check above has passed (state,
    // expiry, revision, responses, adapter presence) and immediately before the
    // write. Never at the top of this method — the marker's lifetime is exactly
    // the window in which our own write can close the prompt, so it can never
    // mask a teardown that has nothing to do with us. Validation stays entirely
    // on the near side of the write: a refused answer writes zero bytes and
    // leaves the record open at its revision, and nothing below moves a check
    // across that boundary.
    entry.answering = true;
    let adapterResult: PromptAdapterResult;
    let threw = false;
    try {
      adapterResult = await entry.adapter({ prompt: copyPrompt(prompt), answer });
    } catch {
      threw = true;
      adapterResult = { ok: false, code: "provider_error" };
    } finally {
      entry.answering = false;
    }
    // A close the detector observed while we were writing is OUR close, held
    // back by providerClosed rather than applied. It settles on every exit that
    // does not resolve, so a refused answer can never leave the record open
    // with the provider's box already gone.
    const deferred = entry.deferredClose;
    entry.deferredClose = undefined;
    const settle = (outcome: PromptAnswerOutcome): PromptAnswerOutcome => {
      if (deferred) this.providerClosed(prompt.promptId, deferred);
      return outcome;
    };

    if (threw) return settle({ ok: false, code: "provider_error" });
    if (entry.prompt.state !== "open" && entry.prompt.state !== "updated") {
      return settle({ ok: false, code: terminalError(entry.prompt.state) });
    }
    if (entry.prompt.revision !== answer.revision) {
      return settle({
        ok: false,
        code: "prompt_revision_mismatch",
        currentRevision: entry.prompt.revision,
      });
    }
    if (!adapterResult.ok) {
      if (adapterResult.terminal) {
        this.transition(
          prompt.promptId,
          adapterResult.terminal.state,
          adapterResult.terminal.reason,
        );
      }
      return settle({ ok: false, code: adapterResult.code });
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

  private scheduleExpiration(entry: PromptEntry): void {
    this.clearExpiration(entry);
    const expiresAt = entry.prompt.expiresAt;
    if (expiresAt === null) return;
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, Date.parse(expiresAt) - this.now()));
    entry.expiryTimer = setTimeout(() => {
      entry.expiryTimer = undefined;
      if (!this.expireIfDue(entry, this.now())) this.scheduleExpiration(entry);
    }, delay);
    entry.expiryTimer.unref?.();
  }

  private clearExpiration(entry: PromptEntry): void {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
  }

  private expireIfDue(entry: PromptEntry, now: number): boolean {
    if (entry.prompt.state !== "open" && entry.prompt.state !== "updated") return false;
    if (entry.prompt.expiresAt === null || now < Date.parse(entry.prompt.expiresAt)) return false;
    const expired = this.transition(entry.prompt.promptId, "expired", "deadline_elapsed");
    this.onExpire?.(expired);
    return true;
  }

  private requireEntry(promptId: string): PromptEntry {
    const entry = this.byId.get(promptId);
    if (!entry) throw new Error(`Unknown prompt: ${promptId}`);
    return entry;
  }

  sweepExpired(sessionId: string): void {
    const now = this.now();
    const session = this.bySession.get(sessionId);
    if (!session) return;
    for (const [promptId, entry] of session) {
      this.expireIfDue(entry, now);
      if (entry.terminalAt !== undefined && now - entry.terminalAt > this.terminalRetentionMs) {
        this.clearExpiration(entry);
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
      const [promptId, entry] = terminal.shift() as [string, PromptEntry];
      this.clearExpiration(entry);
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
