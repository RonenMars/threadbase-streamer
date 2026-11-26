// An empty live question means a form is up that the screen cannot represent.
// It must open nothing and leave the transcript's prompt alone.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";
import type { AskQuestion } from "../src/types";

const SESSION = "unreadable-form-session";
const QUESTIONS: AskQuestion[] = [
  {
    question: "Pick a fruit?",
    header: "Fruit",
    multiSelect: false,
    options: [
      { label: "Apple", description: "" },
      { label: "Pear", description: "" },
    ],
  },
];

describe("handleLiveQuestion with an unreadable form", () => {
  let server: StreamerServer;
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "tb-unreadable-"));
    server = new StreamerServer({
      port: 0,
      apiKey: "tb_unreadable_test_key_00000000000",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      skipStartupWarmup: true,
      cacheDir,
      scanProfiles: [],
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const internals = () => server as any;

  it("opens no prompt", () => {
    internals().sessionHandlers.handleLiveQuestion(SESSION, []);
    expect(internals().promptRegistry.snapshot(SESSION).prompts).toEqual([]);
    expect(internals().pendingQuestions.has(SESSION)).toBe(false);
  });

  it("keeps the transcript prompt", () => {
    internals().sessionHandlers.handleJsonlQuestion(SESSION, "toolu_1", QUESTIONS, "jsonl");
    const before = internals().promptRegistry.snapshot(SESSION).prompts;
    internals().sessionHandlers.handleLiveQuestion(SESSION, []);
    expect(before).toHaveLength(1);
    expect(internals().promptRegistry.snapshot(SESSION).prompts).toEqual(before);
    expect(internals().pendingQuestions.get(SESSION).toolUseId).toBe("toolu_1");
  });
});
