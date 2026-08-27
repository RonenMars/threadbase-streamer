import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../src/schemas/prompt.schema";
import { StreamerServer } from "../src/server";
import type { PromptRegistry } from "../src/services/prompts/promptRegistry";

const API_KEY = "tb_prompt_route_test_key_00000000";
const SESSION = "session-route-1";

function draft(sessionId = SESSION) {
  return {
    sessionId,
    intent: "approval" as const,
    message: "Allow this command?",
    questions: [
      {
        text: "Allow this command?",
        header: "Approval",
        inputMode: "single" as const,
        options: [{ label: "Allow" }, { label: "Deny" }],
        allowOther: false,
        secret: "unknown" as const,
      },
    ],
    answerRequirement: "unknown" as const,
    expiresAt: null,
    provenance: { source: "screen" as const, confidence: "inferred" as const },
  };
}

function body(prompt: Prompt, idempotencyKey: string) {
  return {
    promptId: prompt.promptId,
    revision: prompt.revision,
    responses: [
      {
        questionId: prompt.questions[0].questionId,
        optionIds: [prompt.questions[0].options[0].optionId],
      },
    ],
    idempotencyKey,
  };
}

describe("POST /api/sessions/:id/prompt/answer", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let registry: PromptRegistry;

  beforeEach(async () => {
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "tb-prompt-route-")),
      scanProfiles: [],
    });
    await server.listen(0);
    baseUrl = `http://localhost:${server.port}`;
    registry = (server as unknown as { promptRegistry: PromptRegistry }).promptRegistry;
  });

  afterEach(async () => {
    await server.close();
  });

  async function post(sessionId: string, payload: unknown) {
    return fetch(`${baseUrl}/api/sessions/${sessionId}/prompt/answer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  it("advertises prompt contract version 1 without changing transport", async () => {
    const response = await fetch(`${baseUrl}/api/info`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      promptContract: { schemaVersion: 1, atomicAnswer: true },
    });
  });

  it("settles one prompt atomically and replays a same-key retry", async () => {
    let writes = 0;
    const prompt = registry.open(draft(), async () => {
      writes += 1;
      return { ok: true };
    });

    const [first, retry] = await Promise.all([
      post(SESSION, body(prompt, "same-key")),
      post(SESSION, body(prompt, "same-key")),
    ]);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, prompt: { state: "resolved" } });
    expect(await retry.json()).toMatchObject({ ok: true, prompt: { state: "resolved" } });
    expect(writes).toBe(1);
  });

  it("returns stable errors and never invokes the adapter for refused answers", async () => {
    let writes = 0;
    const prompt = registry.open(draft(), async () => {
      writes += 1;
      return { ok: true };
    });

    const malformed = await post(SESSION, { promptId: prompt.promptId });
    const stale = await post(SESSION, { ...body(prompt, "stale"), revision: 99 });
    const wrongSession = await post("session-route-2", body(prompt, "wrong-session"));

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, code: "invalid_prompt_answer" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      ok: false,
      code: "prompt_revision_mismatch",
      currentRevision: 1,
    });
    expect(wrongSession.status).toBe(404);
    expect(await wrongSession.json()).toEqual({ ok: false, code: "prompt_not_found" });
    expect(writes).toBe(0);
  });

  // The validation class is 400 here exactly as it is on the legacy /answer
  // route; only a prompt whose STATE refuses the answer is 409.
  it("answers 400 for the validation class and 409 only for state conflicts", async () => {
    let writes = 0;
    const prompt = registry.open(draft(), async () => {
      writes += 1;
      return { ok: true };
    });
    const question = prompt.questions[0];
    const refuse = (patch: Record<string, unknown>, key: string) =>
      post(SESSION, { ...body(prompt, key), ...patch });

    const unknownQuestion = await refuse(
      { responses: [{ questionId: "not-a-question", optionIds: [question.options[0].optionId] }] },
      "unknown-question",
    );
    const unknownOption = await refuse(
      { responses: [{ questionId: question.questionId, optionIds: ["not-an-option"] }] },
      "unknown-option",
    );
    const unsupportedShape = await refuse(
      {
        responses: [
          {
            questionId: question.questionId,
            optionIds: [question.options[0].optionId, question.options[1].optionId],
          },
        ],
      },
      "unsupported-shape",
    );
    const incomplete = await refuse(
      { responses: [{ questionId: question.questionId, text: "neither" }] },
      "incomplete",
    );

    expect([
      unknownQuestion.status,
      unknownOption.status,
      unsupportedShape.status,
      incomplete.status,
    ]).toEqual([400, 400, 400, 400]);
    expect(await unknownQuestion.json()).toMatchObject({ code: "unknown_question" });
    expect(await unknownOption.json()).toMatchObject({ code: "unknown_option" });
    expect(await unsupportedShape.json()).toMatchObject({ code: "unsupported_prompt_shape" });
    expect(await incomplete.json()).toMatchObject({ code: "incomplete_answer" });
    expect(writes).toBe(0);

    // Positive control: the same body the four above mutate settles normally.
    const accepted = await post(SESSION, body(prompt, "accepted"));
    expect(accepted.status).toBe(200);
    expect(writes).toBe(1);

    // …and once settled, the state class stays 409.
    const late = await post(SESSION, body(prompt, "late"));
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "already_resolved" });
  });

  it("answers 502 when the provider adapter throws", async () => {
    const prompt = registry.open(draft(), async () => {
      throw new Error("pty write failed");
    });

    const response = await post(SESSION, body(prompt, "provider-error"));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, code: "provider_error" });
  });
});
