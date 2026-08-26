import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import { StreamerServer } from "../src/server";
import type { PromptRegistry } from "../src/services/prompts/promptRegistry";
import { detectGateScreen } from "../src/services/questions/detectPermissionGate";

const API_KEY = "tb_prompt_pty_test_key_000000000";
const SESSION = "prompt-pty-session";
const GATE_SCREEN = [
  "╭──────────────────────────────────────────────────────╮",
  "│ Bash command                                         │",
  "│ npm test                                             │",
  "│ Do you want to proceed?                              │",
  "│ ❯ 2. Yes                                             │",
  "│   3. No                                              │",
  "│ Esc to cancel · Tab to amend                         │",
  "╰──────────────────────────────────────────────────────╯",
];

function waitForLine(lines: string[], match: string, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (lines.some((line) => line.includes(match))) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${match}; output=${JSON.stringify(lines)}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe("atomic prompt answer PTY effect", () => {
  it("writes exactly once for a valid answer and zero bytes for a stale revision", async () => {
    const observed: string[] = [];
    const child = pty.spawn(
      process.execPath,
      [
        "-e",
        [
          "process.stdin.setRawMode(true)",
          "process.stdin.resume()",
          "process.stdout.write('READY\\n')",
          "process.stdin.on('data', chunk => process.stdout.write('OBS:' + Buffer.from(chunk).toString('hex') + '\\n'))",
        ].join(";"),
      ],
      { name: "xterm-color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env },
    );
    child.onData((data) => observed.push(data));
    await waitForLine(observed, "READY");

    const server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      skipStartupWarmup: true,
      cacheDir: mkdtempSync(join(tmpdir(), "tb-prompt-pty-")),
      scanProfiles: [],
    });
    await server.listen(0);
    try {
      const internal = server as unknown as {
        sessionHandlers: {
          handlePermissionChange: (
            sessionId: string,
            gate: ReturnType<typeof detectGateScreen>,
          ) => void;
        };
        promptRegistry: PromptRegistry;
        ptyManager: {
          hasSession: (sessionId: string) => boolean;
          sendKeys: (id: string, keys: string) => void;
        };
      };
      internal.ptyManager.hasSession = () => false;
      internal.ptyManager.sendKeys = (_sessionId, keys) => child.write(keys);
      internal.sessionHandlers.handlePermissionChange(SESSION, detectGateScreen(GATE_SCREEN));
      const prompt = internal.promptRegistry.snapshot(SESSION).prompts[0];
      const answer = {
        promptId: prompt.promptId,
        revision: prompt.revision,
        responses: [
          {
            questionId: prompt.questions[0].questionId,
            optionIds: [prompt.questions[0].options[1].optionId],
          },
        ],
        idempotencyKey: "real-pty-answer",
      };
      const post = (body: unknown) =>
        fetch(`http://localhost:${server.port}/api/sessions/${SESSION}/prompt/answer`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const stale = await post({
        ...answer,
        revision: prompt.revision + 1,
        idempotencyKey: "stale-real-pty-answer",
      });
      expect(stale.status).toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(observed.join("")).not.toContain("OBS:");

      const accepted = await post(answer);
      expect(accepted.status).toBe(200);
      await waitForLine(observed, "OBS:330d");
      expect(observed.join("").match(/OBS:330d/g)).toHaveLength(1);
    } finally {
      await server.close();
      child.kill();
    }
  });
});
