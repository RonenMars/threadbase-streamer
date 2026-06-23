import type { AskQuestion } from "../../types";
import { answersToKeystrokes, UnknownOptionError } from "./answersToKeystrokes";

export type AnswerResolution =
  | { ok: true; keys: string }
  | { ok: false; reason: "no_pending_question" | "tool_use_mismatch" | "unknown_option" };

export function resolveAnswer(
  pending: { toolUseId: string; questions: AskQuestion[] } | undefined,
  body: { toolUseId?: unknown; answers?: unknown },
): AnswerResolution {
  if (!pending) return { ok: false, reason: "no_pending_question" };
  if (typeof body.toolUseId !== "string" || body.toolUseId !== pending.toolUseId) {
    return { ok: false, reason: "tool_use_mismatch" };
  }
  const answers = (body.answers ?? {}) as Record<string, string | string[]>;
  try {
    return { ok: true, keys: answersToKeystrokes(pending.questions, answers) };
  } catch (e) {
    if (e instanceof UnknownOptionError) return { ok: false, reason: "unknown_option" };
    throw e;
  }
}
