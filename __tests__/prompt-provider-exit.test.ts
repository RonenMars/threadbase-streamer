import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamerServer } from "../src/server";
import type { PromptRegistry } from "../src/services/prompts/promptRegistry";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 4243,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const GATE_PAINT = [
  "╭────────────────────────────────────────────────────╮",
  "│ Bash command                                       │",
  "│   npm test                                         │",
  "│ This command requires approval                     │",
  "│                                                    │",
  "│ Do you want to proceed?                            │",
  "│ ❯ 1. Yes                                           │",
  "│   2. Yes, and don't ask again for: npm test        │",
  "│   3. No                                            │",
  "│                                                    │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain   │",
  "╰────────────────────────────────────────────────────╯",
].join("\r\n");

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("provider exit with a prompt open (#714)", () => {
  it("settles the prompt cancelled/provider_exit, broadcasts it, and leaves nothing actionable", async () => {
    const server = new StreamerServer({
      port: 0,
      apiKey: "tb_prompt_exit_key_0000000000000",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      skipStartupWarmup: true,
      cacheDir: mkdtempSync(join(tmpdir(), "tb-prompt-exit-")),
      scanProfiles: [],
    });
    await server.listen(0);
    const internal = server as unknown as {
      promptRegistry: PromptRegistry;
      ptyManager: {
        runners: Map<
          string,
          {
            startFresh: (o: {
              projectPath: string;
              projectName: string;
            }) => Promise<{ id: string }>;
            sessions: Map<string, { process: { _emit: (e: string, d?: unknown) => void } }>;
          }
        >;
      };
      wsHub: { broadcastToClients: (clients: unknown, message: unknown) => void };
    };
    try {
      const messages: { type: string; prompt?: { state: string; terminalReason?: string } }[] = [];
      const real = internal.wsHub.broadcastToClients.bind(internal.wsHub);
      internal.wsHub.broadcastToClients = (clients, message) => {
        messages.push(message as (typeof messages)[number]);
        return real(clients, message);
      };

      const runner = internal.ptyManager.runners.get("claude-code");
      if (!runner) throw new Error("claude runner missing");
      const { id } = await runner.startFresh({ projectPath: "/tmp/tb-exit", projectName: "exit" });
      const proc = runner.sessions.get(id)?.process;
      if (!proc) throw new Error("session did not start");

      proc._emit("data", GATE_PAINT);
      await settle();
      // Positive control: a prompt really is open before the exit.
      const opened = internal.promptRegistry.snapshot(id).prompts.at(-1);
      expect(opened?.state).toBe("open");
      messages.length = 0;

      proc._emit("exit", { exitCode: 1 });
      await settle();

      const settled = internal.promptRegistry.get(opened?.promptId ?? "");
      expect(settled?.state).toBe("cancelled");
      expect(settled?.terminalReason).toBe("provider_exit");
      expect(
        messages.some(
          (m) =>
            m.type === "prompt_event" &&
            m.prompt?.state === "cancelled" &&
            m.prompt?.terminalReason === "provider_exit",
        ),
      ).toBe(true);
      expect(internal.promptRegistry.hasOpen(id)).toBe(false);
    } finally {
      await server.close();
    }
  });
});
