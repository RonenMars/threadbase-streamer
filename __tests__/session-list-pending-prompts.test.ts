import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamerServer } from "../src/server";
import type { PromptRegistry } from "../src/services/prompts/promptRegistry";
import { detectGateScreen } from "../src/services/questions/detectPermissionGate";

// A list screen answers a waiting session without subscribing to it, so
// GET /api/sessions carries the session's actionable prompts, on the same
// contract as prompt_snapshot, and only while they can still be answered.

const API_KEY = "tb_test_list_pending_prompts";

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

describe("GET /api/sessions pendingPrompts", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let port: number;
  let internals: {
    sessionStore: { addManaged: (s: unknown) => void };
    sessionHandlers: {
      handlePermissionChange: (id: string, gate: unknown) => void;
      handleJsonlQuestion: (id: string, toolUseId: string, questions: unknown[]) => void;
    };
    promptRegistry: PromptRegistry;
  };

  const addSession = (id: string) =>
    internals.sessionStore.addManaged({
      id,
      provider: "claude-code",
      status: "waiting_input",
      statusSource: "user-input",
      projectPath: "/tmp",
      projectName: "test",
      branch: "",
      promptCount: 1,
      startedAt: new Date(),
      completedAt: null,
      lastOutput: "",
    });

  const get = async (path: string) => {
    const res = await fetch(`http://localhost:${port}${path}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    return res.json();
  };
  const bare = async (id: string) =>
    (await get("/api/sessions")).find((s: { id: string }) => s.id === id);
  const paged = async (id: string) =>
    (await get("/api/sessions?limit=50")).sessions.find((s: { id: string }) => s.id === id);

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    cacheDir = mkdtempSync(join(tmpdir(), "tb-list-pending-"));
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
    internals = server as unknown as typeof internals;
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("omits the field when nothing is pending", async () => {
    addSession("nothing-pending");
    expect(await bare("nothing-pending")).not.toHaveProperty("pendingPrompts");
    expect(await paged("nothing-pending")).not.toHaveProperty("pendingPrompts");
  });

  it("carries a permission gate on both list shapes, then clears when it closes", async () => {
    const id = "gated";
    addSession(id);
    internals.sessionHandlers.handlePermissionChange(id, detectGateScreen(GATE_SCREEN));

    const [prompt] = internals.promptRegistry.snapshot(id).prompts;
    for (const session of [await bare(id), await paged(id)]) {
      expect(session.pendingPrompts).toEqual([JSON.parse(JSON.stringify(prompt))]);
      expect(session.pendingPrompts[0].questions[0].options.length).toBeGreaterThan(0);
    }

    internals.sessionHandlers.handlePermissionChange(id, null);
    expect(await bare(id)).not.toHaveProperty("pendingPrompts");
    expect(await paged(id)).not.toHaveProperty("pendingPrompts");
  });

  it("carries a question with its options, and shows the latest revision", async () => {
    const id = "asking";
    addSession(id);
    internals.sessionHandlers.handleJsonlQuestion(id, "toolu_1", [
      {
        question: "Which database?",
        header: "DB",
        multiSelect: false,
        options: [{ label: "SQLite" }, { label: "Postgres" }],
      },
    ]);

    const [listed] = (await bare(id)).pendingPrompts;
    expect(listed.intent).toBe("question");
    expect(listed.questions[0].options.map((o: { label: string }) => o.label)).toEqual([
      "SQLite",
      "Postgres",
    ]);

    const open = internals.promptRegistry.snapshot(id).prompts[0];
    internals.promptRegistry.update(open.promptId, { ...open, message: "Which store?" } as never);
    const [revised] = (await paged(id)).pendingPrompts;
    expect(revised.state).toBe("updated");
    expect(revised.revision).toBe(open.revision + 1);
  });
});
