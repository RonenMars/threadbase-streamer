// P0.2 — JSONL-derived AskUserQuestion safety:
//   (a) suppressed entirely for a contended session (the line may be authored
//       by the other owner of a shared conversation), and
//   (b) never clobbers a live PTY-screen question that is a DIFFERENT question.
// Drives the extracted processJsonlQuestions() directly for determinism.

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

// A JSONL line carrying an AskUserQuestion tool_use, as Claude writes it.
function qLine(question: string, labels: string[], toolUseId: string): string {
  return JSON.stringify({
    message: {
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question,
                header: "H",
                options: labels.map((l) => ({ label: l, description: "" })),
              },
            ],
          },
        },
      ],
    },
  });
}

// The parsed AskQuestion[] equivalent, as the live-screen path supplies it.
function qParsed(question: string, labels: string[]): AskQuestion[] {
  return [
    {
      question,
      header: "H",
      multiSelect: false,
      options: labels.map((l) => ({ label: l, description: "" })),
    },
  ];
}

describe("processJsonlQuestions — P0.2 suppression + anti-clobber", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let broadcasts: Array<{ type: string; toolUseId?: string }>;

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    const port = await getRandomPort();
    cacheDir = mkdtempSync(join(tmpdir(), "tb-jsonl-q-cache-"));
    server = new StreamerServer({
      port,
      apiKey: "tb_test_jsonl_q",
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
    broadcasts = [];
    vi.spyOn((server as any).wsHub, "broadcast").mockImplementation((...args: unknown[]) => {
      broadcasts.push(args[0] as { type: string; toolUseId?: string });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) suppresses a JSONL question card when the session is contended", () => {
    const SID = "contended-sess";
    (server as any).contendedSessions.add(SID);

    (server as any).processJsonlQuestions(SID, [
      qLine("Deploy to prod?", ["yes", "no"], "toolu_ext"),
    ]);

    expect(broadcasts.some((b) => b.type === "question")).toBe(false);
    expect((server as any).pendingQuestions.has(SID)).toBe(false);
  });

  it("broadcasts and stores a JSONL question when the session is NOT contended", () => {
    const SID = "normal-sess";

    (server as any).processJsonlQuestions(SID, [qLine("Pick one", ["a", "b"], "toolu_norm")]);

    expect(broadcasts.some((b) => b.type === "question" && b.toolUseId === "toolu_norm")).toBe(
      true,
    );
    const pending = (server as any).pendingQuestions.get(SID);
    expect(pending?.toolUseId).toBe("toolu_norm");
    expect(pending?.origin).toBe("jsonl");
  });

  it("(b) a foreign JSONL question does not clobber a different PTY-screen question", () => {
    const SID = "pty-owned-sess";
    // A genuine live question originates from the PTY-screen path.
    (server as any).handleLiveQuestion(SID, qParsed("Ready to ship?", ["ship", "wait"]));
    const screenToolUseId = (server as any).pendingQuestions.get(SID).toolUseId;
    expect(screenToolUseId.startsWith("screen:")).toBe(true);
    broadcasts = []; // ignore the screen broadcast

    // An external agent appends a DIFFERENT question into the shared JSONL.
    (server as any).processJsonlQuestions(SID, [
      qLine("Delete everything?", ["confirm", "cancel"], "toolu_foreign"),
    ]);

    // The pending question is untouched — still the PTY one.
    const pending = (server as any).pendingQuestions.get(SID);
    expect(pending.toolUseId).toBe(screenToolUseId);
    expect(pending.origin).toBe("pty");
    // The foreign question was never broadcast.
    expect(broadcasts.some((b) => b.toolUseId === "toolu_foreign")).toBe(false);
  });

  it("re-sync: the SAME question's JSONL flush updates the toolUseId, origin stays pty", () => {
    const SID = "resync-sess";
    (server as any).handleLiveQuestion(SID, qParsed("Merge now?", ["merge", "hold"]));
    broadcasts = [];

    // JSONL flush of the same question carries the real toolUseId.
    (server as any).processJsonlQuestions(SID, [
      qLine("Merge now?", ["merge", "hold"], "toolu_real"),
    ]);

    const pending = (server as any).pendingQuestions.get(SID);
    expect(pending.toolUseId).toBe("toolu_real");
    expect(pending.origin).toBe("pty");
    // Re-broadcast so the client swaps the synthetic screen id for the real one.
    expect(broadcasts.some((b) => b.type === "question" && b.toolUseId === "toolu_real")).toBe(
      true,
    );
  });
});
