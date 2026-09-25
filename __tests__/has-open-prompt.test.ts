import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { StreamerServer } from "../src/server";
import type { PromptRegistry } from "../src/services/prompts/promptRegistry";
import { detectGateScreen } from "../src/services/questions/detectPermissionGate";

// A permission gate during a turn keeps `status: running` (#962), and the
// prompt frames go only to the session's subscribers. `hasOpenPrompt` on the
// session object is how a client that is not subscribed — a list screen — can
// still tell the session is waiting on the user (docs/streamer-state-model.md
// F-164, F-612).

const API_KEY = "tb_test_has_open_prompt";
const SID = "gated-session";

const GATE_SCREEN = [
  "╭──────────────────────────────────────────────────────╮",
  "│ Bash command                                         │",
  "│                                                      │",
  "│ rm -rf /tmp/build-cache                              │",
  "│                                                      │",
  "│ Do you want to proceed?                              │",
  "│ ❯ 2. Yes                                             │",
  "│   3. No, and tell Claude what to do differently      │",
  "│                                                      │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain     │",
  "╰──────────────────────────────────────────────────────╯",
];

type Client = { ws: WebSocket; frames: any[] };

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?key=${API_KEY}`);
  const frames: any[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, frames };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

const updates = (c: Client) =>
  c.frames.filter((f) => f.type === "session_update" && f.session?.id === SID);

describe("hasOpenPrompt reaches clients that are not subscribed", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let port: number;

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    cacheDir = mkdtempSync(join(tmpdir(), "tb-has-open-prompt-"));
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
      cursorRoots: [],
    });
    await server.listen(0);
    port = server.port;
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("flips on open, not on a revision, and back off when the prompt closes", async () => {
    const internals = server as unknown as {
      sessionStore: { addManaged: (s: unknown) => void };
      sessionHandlers: { handlePermissionChange: (id: string, gate: unknown) => void };
      promptRegistry: PromptRegistry;
    };
    internals.sessionStore.addManaged({
      id: SID,
      provider: "claude-code",
      status: "running",
      statusSource: "user-input",
      projectPath: "/tmp",
      projectName: "test",
      branch: "",
      promptCount: 1,
      startedAt: new Date(),
      completedAt: null,
      lastOutput: "",
    });

    const getSession = async () => {
      const res = await fetch(`http://localhost:${port}/api/sessions/${SID}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      return res.json();
    };

    const listener = await connect(port); // the list screen: subscribes to nothing
    await waitFor(() => listener.frames.some((f) => f.type === "session_list"));
    const list = listener.frames.find((f) => f.type === "session_list");
    expect(list.sessions.find((s: { id: string }) => s.id === SID)?.hasOpenPrompt).toBe(false);
    expect((await getSession()).hasOpenPrompt).toBe(false);

    // ── open ──
    internals.sessionHandlers.handlePermissionChange(SID, detectGateScreen(GATE_SCREEN));
    await waitFor(() => updates(listener).length >= 1);
    expect(updates(listener)).toHaveLength(1);
    expect(updates(listener)[0].session).toMatchObject({ status: "running", hasOpenPrompt: true });
    expect(listener.frames.some((f) => f.type === "prompt_event")).toBe(false);
    expect((await getSession()).hasOpenPrompt).toBe(true);

    // ── revision of the already-open prompt: no new session_update ──
    const open = internals.promptRegistry
      .snapshot(SID)
      .prompts.find((p) => p.state === "open" || p.state === "updated");
    expect(open).toBeDefined();
    const { promptId, message } = open as { promptId: string; message: string };
    internals.promptRegistry.update(promptId, {
      ...(open as any),
      message: `${message} (repainted)`,
    });
    expect(internals.promptRegistry.get(promptId)?.state).toBe("updated");
    // Give a stray broadcast the same chance to land that the open had.
    const control = await connect(port);
    await waitFor(() => control.frames.some((f) => f.type === "session_list"));
    expect(updates(listener)).toHaveLength(1);

    // ── close ──
    internals.sessionHandlers.handlePermissionChange(SID, null);
    await waitFor(() => updates(listener).length >= 2);
    expect(updates(listener)).toHaveLength(2);
    expect(updates(listener)[1].session).toMatchObject({ status: "running", hasOpenPrompt: false });
    expect((await getSession()).hasOpenPrompt).toBe(false);

    for (const c of [listener, control]) c.ws.close();
  });
});
