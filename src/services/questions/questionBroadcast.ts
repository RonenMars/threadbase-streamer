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
