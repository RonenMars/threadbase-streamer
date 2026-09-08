// A question card can reach a client two ways — a screen scrape that
// broadcasts `question`, and a JSONL flush that only sets pendingQuestions for
// the next GET /api/sessions/:id — and neither used to leave a log line, while
// the permission gate beside them logged every broadcast. That asymmetry is
// what made "did this server send that card at all?" unanswerable from the
// log; the card in #821 turned out to have been built by the client.
//
// The lines must carry shape only: question and option TEXT never enters logs.

import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import type { StreamerServer } from "../src/server";
import type { AskQuestion } from "../src/types";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const SECRET = "Deploy to production?";
const OPTION_SECRET = "Yes, deploy the release";

const QUESTIONS: AskQuestion[] = [
  {
    question: SECRET,
    header: "Deploy",
    multiSelect: false,
    options: [
      { label: OPTION_SECRET, description: "" },
      { label: "No, hold", description: "" },
    ],
  },
];

describe("question broadcast logging", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let logged: Array<{ msg: string; fields: Record<string, unknown> }>;

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    const port = await getRandomPort();
    cacheDir = mkdtempSync(join(tmpdir(), "tb-question-log-cache-"));
    server = new StreamerServer({
      port,
      apiKey: "tb_test_question_log",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    logged = [];
    vi.spyOn((server as any).sessionHandlers.log, "info").mockImplementation(
      (...args: unknown[]) => {
        logged.push({
          msg: String(args[0]),
          fields: (args[1] ?? {}) as Record<string, unknown>,
        });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the screen-scraped question broadcast with its shape", () => {
    (server as any).sessionHandlers.handleLiveQuestion("log-live-sess", QUESTIONS);

    const line = logged.find((l) => l.fields.event === "ws.broadcast_question");
    expect(line?.fields).toMatchObject({
      sessionId: "log-live-sess",
      origin: "screen",
      questionCount: 1,
      optionCount: 2,
    });
  });

  it("logs the JSONL question that only becomes pending, with no broadcast", () => {
    (server as any).sessionHandlers.handleJsonlQuestion(
      "log-jsonl-sess",
      "toolu_test",
      QUESTIONS,
      "jsonl",
    );

    const line = logged.find((l) => l.fields.event === "question.pending");
    expect(line?.fields).toMatchObject({
      sessionId: "log-jsonl-sess",
      origin: "jsonl",
      questionCount: 1,
      optionCount: 2,
    });
  });

  it("never puts question or option text in the log", () => {
    (server as any).sessionHandlers.handleLiveQuestion("log-text-sess", QUESTIONS);
    (server as any).sessionHandlers.handleJsonlQuestion(
      "log-text-sess-2",
      "toolu_test",
      QUESTIONS,
      "jsonl",
    );

    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(OPTION_SECRET);
  });
});
