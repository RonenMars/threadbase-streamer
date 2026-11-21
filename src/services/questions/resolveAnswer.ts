import type { AskQuestion } from "../../types";
import {
  type AnswerValue,
  IncompleteAnswerError,
  InvalidTextError,
  planAnswer,
  UnknownOptionError,
  UnsupportedPromptShapeError,
} from "./answersToKeystrokes";

export type AnswerResolution =
  | { ok: true; keys: string }
  // Free text: not one burst of keys, the handler sequences it (see planAnswer).
  | { ok: true; freeText: { row: number; text: string } }
  | {
      ok: false;
      reason:
        | "no_pending_question"
        | "tool_use_mismatch"
        | "unknown_option"
        | "unsupported_prompt_shape"
        | "incomplete_answer"
        | "invalid_text";
    };

export function resolveAnswer(
  pending: { toolUseId: string; questions: AskQuestion[] } | undefined,
  body: { toolUseId?: unknown; answers?: unknown },
): AnswerResolution {
  if (!pending) return { ok: false, reason: "no_pending_question" };
  if (typeof body.toolUseId !== "string" || body.toolUseId !== pending.toolUseId) {
    return { ok: false, reason: "tool_use_mismatch" };
  }
  const answers = (body.answers ?? {}) as Record<string, AnswerValue>;
  try {
    return { ok: true, ...planAnswer(pending.questions, answers) };
  } catch (e) {
    if (e instanceof UnknownOptionError) return { ok: false, reason: "unknown_option" };
    if (e instanceof UnsupportedPromptShapeError) {
      return { ok: false, reason: "unsupported_prompt_shape" };
    }
    if (e instanceof InvalidTextError) return { ok: false, reason: "invalid_text" };
    if (e instanceof IncompleteAnswerError) return { ok: false, reason: "incomplete_answer" };
    throw e;
  }
}
