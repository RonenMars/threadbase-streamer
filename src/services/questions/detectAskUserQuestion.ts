import type { AskQuestion, AskOption } from "../../types";

type ContentBlock = { type: string; name?: string; id?: string; input?: unknown; [key: string]: unknown };

interface JsonlLineShape {
  content?: ContentBlock[] | string;
  message?: { content?: ContentBlock[] | string };
}

function normalizeContent(raw: ContentBlock[] | string | null | undefined): ContentBlock[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return [];
}

function coerceOptions(raw: unknown): AskOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AskOption[] = [];
  for (const o of raw) {
    if (o && typeof o === "object" && typeof (o as AskOption).label === "string") {
      const opt = o as { label: string; description?: unknown; preview?: unknown };
      out.push({
        label: opt.label,
        description: typeof opt.description === "string" ? opt.description : "",
        ...(typeof opt.preview === "string" ? { preview: opt.preview } : {}),
      });
    }
  }
  return out.length > 0 ? out : null;
}

function coerceQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qq = q as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
    const options = coerceOptions(qq.options);
    if (typeof qq.question !== "string" || !options) continue;
    out.push({
      question: qq.question,
      header: typeof qq.header === "string" ? qq.header : "",
      multiSelect: qq.multiSelect === true,
      options,
    });
  }
  return out.length > 0 ? out : null;
}

export function detectAskUserQuestion(rawLine: string): { toolUseId: string; questions: AskQuestion[] } | null {
  let parsed: JsonlLineShape;
  try {
    parsed = JSON.parse(rawLine) as JsonlLineShape;
  } catch {
    return null;
  }
  const blocks = normalizeContent(parsed.message?.content ?? parsed.content);
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === "AskUserQuestion" && typeof b.id === "string") {
      const input = b.input as { questions?: unknown } | undefined;
      const questions = coerceQuestions(input?.questions);
      if (questions) return { toolUseId: b.id, questions };
    }
  }
  return null;
}
