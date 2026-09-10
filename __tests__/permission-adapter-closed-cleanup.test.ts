// The contract answer route must retire a permission entry whose box is gone,
// exactly as the legacy route's gateClosed() does. permissionAnswerAdapter
// returned prompt_cancelled from a failed freshness scrape but left
// pendingPermission behind, so /input kept refusing composer text beside a
// cancelled record ("A prompt is waiting for an answer…") with no card to answer.

import { mkdtempSync, rmSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import type { StreamerServer } from "../src/server";

function request(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as any).headers = { "content-type": "application/json" };
  return req;
}

function response(): { res: ServerResponse; status: () => number | undefined } {
  let code: number | undefined;
  const res = {
    writeHead(s: number) {
      code = s;
      return this;
    },
    setHeader() {},
    end() {},
    statusCode: 200,
  } as unknown as ServerResponse;
  return { res, status: () => code };
}

const GATE = {
  prompt: "Do you want to proceed?",
  options: [
    { index: 1, label: "Yes" },
    { index: 2, label: "No" },
  ],
  cursor: 0,
};
const OTHER_GATE = {
  prompt: "Do you want to make this edit?",
  options: [
    { index: 1, label: "Yes" },
    { index: 2, label: "No" },
  ],
  cursor: 0,
};
// A screen with no gate painted: permissionGateStillOpen's scrape finds nothing.
const NO_GATE_SCREEN = ["some output", "❯ "];

describe("permissionAnswerAdapter — failed freshness scrape", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let broadcasts: Array<{ type: string }>;
  let written: string[];

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    cacheDir = mkdtempSync(join(tmpdir(), "tb-perm-adapter-cleanup-"));
    server = new StreamerServer({
      port: 0,
      apiKey: "tb_test_perm_adapter_cleanup",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(0);
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    broadcasts = [];
    written = [];
    vi.spyOn((server as any).wsHub, "broadcastToClients").mockImplementation(
      (...args: unknown[]) => {
        broadcasts.push(args[1] as { type: string });
      },
    );
    vi.spyOn((server as any).ptyManager, "hasSession").mockReturnValue(true);
    vi.spyOn((server as any).ptyManager, "sendKeys").mockImplementation(
      (_id: string, k: string) => {
        written.push(k);
      },
    );
    vi.spyOn((server as any).ptyManager, "sendInput").mockImplementation(() => 1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function answerFirstOption(SID: string) {
    const registry = (server as any).promptRegistry;
    const prompt = registry
      .snapshot(SID)
      .prompts.find((p: any) => p.state === "open" || p.state === "updated");
    return registry.answer(SID, {
      promptId: prompt.promptId,
      revision: prompt.revision,
      responses: [
        {
          questionId: prompt.questions[0].questionId,
          optionIds: [prompt.questions[0].options[0].optionId],
        },
      ],
      idempotencyKey: `idem-${SID}`,
    });
  }

  it("clears the stale entry so composer text goes through", async () => {
    const SID = "adapter-closed-sess";
    vi.spyOn((server as any).ptyManager, "getOutputLines").mockResolvedValue(NO_GATE_SCREEN);
    (server as any).sessionHandlers.handlePermissionChange(SID, GATE);
    broadcasts = [];

    const outcome = await answerFirstOption(SID);

    expect(outcome).toMatchObject({ ok: false, code: "prompt_cancelled" });
    expect(written).toEqual([]);
    expect((server as any).pendingPermission.has(SID)).toBe(false);
    expect(broadcasts.some((b) => b.type === "permission_cancelled")).toBe(true);

    const { res, status } = response();
    await (server as any).sessionHandlers.handleSendInput(SID, request({ input: "hello" }), res);
    expect(status()).toBe(200);
  });

  it("leaves a newer gate that took the screen during the scrape untouched", async () => {
    const SID = "adapter-replaced-sess";
    const handlers = (server as any).sessionHandlers;
    handlers.handlePermissionChange(SID, GATE);
    // While the freshness scrape is in flight a different gate takes the screen.
    vi.spyOn((server as any).ptyManager, "getOutputLines").mockImplementation(async () => {
      handlers.handlePermissionChange(SID, OTHER_GATE);
      return NO_GATE_SCREEN;
    });

    await answerFirstOption(SID);

    const pending = (server as any).pendingPermission.get(SID);
    expect(pending?.prompt).toBe(OTHER_GATE.prompt);
    expect(written).toEqual([]);
  });
});
