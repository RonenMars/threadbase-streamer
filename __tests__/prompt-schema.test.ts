import { PROMPT_SCHEMA_VERSION } from "../src/index";
import { PromptAnswerSchema, PromptSchema } from "../src/schemas/prompt.schema";

const approvalPrompt = {
  schemaVersion: 1,
  sessionId: "session-1",
  promptId: "prompt-1",
  revision: 1,
  state: "open",
  intent: "approval",
  message: "Allow this command?",
  detail: "npm test",
  questions: [
    {
      questionId: "question-1",
      text: "Allow this command?",
      header: "Approval",
      inputMode: "single",
      options: [
        { optionId: "option-allow", label: "Allow" },
        { optionId: "option-deny", label: "Deny" },
      ],
      allowOther: false,
      secret: "unknown",
    },
  ],
  answerRequirement: "unknown",
  expiresAt: null,
  provenance: { source: "screen", confidence: "inferred" },
};

describe("PromptSchema", () => {
  it("exports the negotiated schema version from the package entry point", () => {
    expect(PROMPT_SCHEMA_VERSION).toBe(1);
  });

  it("accepts the complete version 1 provider-neutral envelope", () => {
    expect(PromptSchema.parse(approvalPrompt)).toEqual(approvalPrompt);
  });

  it("requires one meaningful presentation string", () => {
    const result = PromptSchema.safeParse({
      ...approvalPrompt,
      message: "   ",
      detail: undefined,
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate question and option ids", () => {
    const question = approvalPrompt.questions[0];
    const result = PromptSchema.safeParse({
      ...approvalPrompt,
      questions: [
        question,
        {
          ...question,
          options: [question.options[0], { ...question.options[1], optionId: "option-allow" }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("requires a terminal reason for terminal states", () => {
    const result = PromptSchema.safeParse({
      ...approvalPrompt,
      state: "cancelled",
      revision: 2,
    });

    expect(result.success).toBe(false);
  });
});

describe("PromptAnswerSchema", () => {
  it("accepts an atomic id-targeted option answer", () => {
    const body = {
      promptId: "prompt-1",
      revision: 1,
      responses: [{ questionId: "question-1", optionIds: ["option-allow"] }],
      idempotencyKey: "retry-1",
    };

    expect(PromptAnswerSchema.parse(body)).toEqual(body);
  });

  it("rejects a response carrying both text and option ids", () => {
    const result = PromptAnswerSchema.safeParse({
      promptId: "prompt-1",
      revision: 1,
      responses: [{ questionId: "question-1", optionIds: ["option-allow"], text: "also allow" }],
      idempotencyKey: "retry-1",
    });

    expect(result.success).toBe(false);
  });

  it("requires a client idempotency key", () => {
    const result = PromptAnswerSchema.safeParse({
      promptId: "prompt-1",
      revision: 1,
      responses: [{ questionId: "question-1", optionIds: ["option-allow"] }],
    });

    expect(result.success).toBe(false);
  });
});
