import type { AskQuestion, WSMessage } from "../../types";
import { detectAskUserQuestion } from "./detectAskUserQuestion";

export interface PendingQuestion {
  toolUseId: string;
  questions: AskQuestion[];
}

// Pure decision: given the new lines for a session, returns the question messages
// to broadcast and the pending-question records to store. No I/O.
export function questionsFromLines(
  sessionId: string,
  lines: string[],
): {
  messages: Extract<WSMessage, { type: "question" }>[];
  pending: PendingQuestion[];
} {
  const messages: Extract<WSMessage, { type: "question" }>[] = [];
  const pending: PendingQuestion[] = [];
  for (const line of lines) {
    const detected = detectAskUserQuestion(line);
    if (detected) {
      messages.push({
        type: "question",
        sessionId,
        toolUseId: detected.toolUseId,
        questions: detected.questions,
      });
      pending.push(detected);
    }
  }
  return { messages, pending };
}

// Pure decision: should the JSONL-flush path (re-)broadcast this question?
//
// The live-screen detector may have already broadcast the same question under a
// synthetic `screen:…` toolUseId. When that JSONL line lands with the REAL
// toolUseId we must re-broadcast — even though the content is identical — so the
// client swaps the stale screen id for the real one. Otherwise the client
// answers with the screen id and resolveAnswer rejects it as tool_use_mismatch.
//
// - Not shown before (different/absent content key) → broadcast (new card).
// - Shown before AND the toolUseId changed → broadcast (re-sync the id).
// - Shown before AND same toolUseId → suppress (true duplicate).
export function shouldBroadcastQuestion(args: {
  newContentKey: string;
  lastContentKey: string | undefined;
  newToolUseId: string;
  priorToolUseId: string | undefined;
}): boolean {
  const alreadyShown = args.lastContentKey === args.newContentKey;
  if (!alreadyShown) return true;
  return args.priorToolUseId !== args.newToolUseId;
}
