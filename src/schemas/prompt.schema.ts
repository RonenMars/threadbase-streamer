import { z } from "zod";

export const PROMPT_SCHEMA_VERSION = 1 as const;

const OpaqueIdSchema = z.string().trim().min(1).max(200);
const MeaningfulStringSchema = z.string().trim().min(1);

export const PromptOptionSchema = z.object({
  optionId: OpaqueIdSchema,
  label: MeaningfulStringSchema,
  description: z.string().optional(),
  preview: z.string().optional(),
});

export const PromptQuestionSchema = z
  .object({
    questionId: OpaqueIdSchema,
    text: MeaningfulStringSchema,
    header: z.string().optional(),
    inputMode: z.enum(["single", "multi", "text"]),
    options: z.array(PromptOptionSchema),
    allowOther: z.boolean(),
    secret: z.union([z.boolean(), z.literal("unknown")]),
  })
  .superRefine((question, ctx) => {
    const optionIds = question.options.map((option) => option.optionId);
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "optionId values must be unique",
        path: ["options"],
      });
    }
    if (question.inputMode === "text" && question.options.length !== 0) {
      ctx.addIssue({
        code: "custom",
        message: "text questions cannot carry options",
        path: ["options"],
      });
    }
    if (question.inputMode !== "text" && question.options.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "select questions require options",
        path: ["options"],
      });
    }
  });

const TERMINAL_PROMPT_STATES = new Set(["resolved", "cancelled", "expired", "unavailable"]);

export const PromptSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    promptId: OpaqueIdSchema,
    revision: z.number().int().positive(),
    state: z.enum(["open", "updated", "resolved", "cancelled", "expired", "unavailable"]),
    terminalReason: MeaningfulStringSchema.optional(),
    intent: z.enum(["approval", "question"]),
    title: z.string().optional(),
    message: z.string().optional(),
    detail: z.string().optional(),
    questions: z.array(PromptQuestionSchema).min(1),
    answerRequirement: z.enum(["blocking", "non_blocking", "unknown"]),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    provenance: z.object({
      source: z.enum(["provider", "screen", "transcript", "synthetic"]),
      confidence: z.enum(["authoritative", "inferred"]),
    }),
  })
  .superRefine((prompt, ctx) => {
    if (![prompt.title, prompt.message, prompt.detail].some((value) => value?.trim())) {
      ctx.addIssue({
        code: "custom",
        message: "prompt requires a meaningful title, message, or detail",
        path: ["message"],
      });
    }
    const questionIds = prompt.questions.map((question) => question.questionId);
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "questionId values must be unique",
        path: ["questions"],
      });
    }
    const optionIds = prompt.questions.flatMap((question) =>
      question.options.map((option) => option.optionId),
    );
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "optionId values must be unique within a prompt",
        path: ["questions"],
      });
    }
    const terminal = TERMINAL_PROMPT_STATES.has(prompt.state);
    if (terminal !== (prompt.terminalReason !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: terminal
          ? "terminal prompts require terminalReason"
          : "actionable prompts cannot carry terminalReason",
        path: ["terminalReason"],
      });
    }
  });

const OptionResponseSchema = z.object({
  questionId: OpaqueIdSchema,
  optionIds: z
    .array(OpaqueIdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "optionIds must be unique"),
  text: z.never().optional(),
});

const TextResponseSchema = z.object({
  questionId: OpaqueIdSchema,
  text: z.string(),
  optionIds: z.never().optional(),
});

export const PromptResponseSchema = z.union([OptionResponseSchema, TextResponseSchema]);

export const PromptAnswerSchema = z
  .object({
    promptId: OpaqueIdSchema,
    revision: z.number().int().positive(),
    responses: z.array(PromptResponseSchema).min(1),
    idempotencyKey: OpaqueIdSchema,
  })
  .superRefine((answer, ctx) => {
    const questionIds = answer.responses.map((response) => response.questionId);
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "each questionId can be answered only once",
        path: ["responses"],
      });
    }
  });

export type Prompt = z.infer<typeof PromptSchema>;
export type PromptQuestion = z.infer<typeof PromptQuestionSchema>;
export type PromptOption = z.infer<typeof PromptOptionSchema>;
export type PromptAnswer = z.infer<typeof PromptAnswerSchema>;
export type PromptResponse = z.infer<typeof PromptResponseSchema>;
