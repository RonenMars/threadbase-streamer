import type { AskQuestion } from "../../types";
import type { PermissionGate } from "../questions/detectPermissionGate";
import type { PromptDraft } from "./promptRegistry";

export function permissionPromptDraft(sessionId: string, gate: PermissionGate | null): PromptDraft {
  if (!gate) throw new Error("Cannot normalize an absent permission gate");
  const message = gate.prompt?.trim() || "Approval required";
  return {
    sessionId,
    intent: "approval",
    title: "Approval",
    message,
    ...(gate.detail?.trim() ? { detail: gate.detail } : {}),
    questions: [
      {
        text: message,
        header: "Approval",
        inputMode: "single",
        options: gate.options.map((option) => ({ label: option.label })),
        allowOther: false,
        secret: "unknown",
      },
    ],
    answerRequirement: "unknown",
    expiresAt: null,
    provenance: { source: "screen", confidence: "inferred" },
  };
}

export function questionPromptDraft(
  sessionId: string,
  questions: AskQuestion[],
  source: "screen" | "transcript",
): PromptDraft {
  const first = questions[0];
  if (!first) throw new Error("Cannot normalize an empty question list");
  return {
    sessionId,
    intent: "question",
    ...(first.header.trim() ? { title: first.header } : {}),
    message: first.question,
    questions: questions.map((question) => ({
      text: question.question,
      ...(question.header.trim() ? { header: question.header } : {}),
      inputMode: question.multiSelect ? "multi" : "single",
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.preview ? { preview: option.preview } : {}),
      })),
      allowOther: false,
      secret: "unknown",
    })),
    answerRequirement: "unknown",
    expiresAt: null,
    provenance: {
      source,
      confidence: source === "transcript" ? "authoritative" : "inferred",
    },
  };
}
