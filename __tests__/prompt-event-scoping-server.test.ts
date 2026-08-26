import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { StreamerServer } from "../src/server";
import { detectGateScreen } from "../src/services/questions/detectPermissionGate";

// The same invariant as prompt-event-scoping.test.ts, end to end: a real
// StreamerServer, its real WSHub and subscriber map, and real WebSocket
// clients. This is the only harness that reaches the JSONL question path
// (processJsonlQuestions / cancelPendingQuestion are private to the server)
// and the subscribe replay a late subscriber depends on once broadcasts are
// scoped.

const API_KEY = "tb_test_prompt_scoping";
const SID = "scoped-session";
const OTHER = "other-session";
const PROMPT_TYPES = new Set([
  "question",
  "permission",
  "question_cancelled",
  "permission_cancelled",
]);

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

// An AskUserQuestion tool_use line as the JSONL watcher would hand it over.
const QUESTION_LINE = JSON.stringify({
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_scoped",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which language?",
              header: "Language",
              options: [
                { label: "TypeScript", description: "" },
                { label: "Rust", description: "" },
              ],
            },
          ],
        },
      },
    ],
  },
});

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Frame = {
  type: string;
  sessionId?: string;
  gateId?: string;
  toolUseId?: string;
  prompt?: { intent?: string; message?: string };
  prompts?: Array<{ intent?: string; message?: string }>;
};
type Client = { ws: WebSocket; frames: Frame[] };

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?key=${API_KEY}`);
  const frames: Frame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, frames };
}

const prompts = (c: Client) => c.frames.filter((f) => PROMPT_TYPES.has(f.type));
const types = (c: Client) => c.frames.map((f) => f.type);

describe("prompt events over real sockets reach only the session's subscribers", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let port: number;

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    port = await getRandomPort();
    cacheDir = mkdtempSync(join(tmpdir(), "tb-prompt-scoping-"));
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);
    port = server.port;
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("scopes open, replay-on-late-subscribe, and cancel", async () => {
    const internals = server as unknown as {
      sessionSubscribers: Map<string, Set<WebSocket>>;
      sessionHandlers: {
        handlePermissionChange: (id: string, gate: unknown) => void;
      };
      processJsonlQuestions: (id: string, lines: string[]) => void;
      cancelPendingQuestion: (id: string) => void;
      wsHub: { broadcast: (m: unknown) => void };
    };

    const a = await connect(port); // subscribed to SID
    const b = await connect(port); // connected, subscribes to nothing (yet)
    const c = await connect(port); // subscribed to a different session
    a.ws.send(JSON.stringify({ type: "subscribe_session", sessionId: SID }));
    c.ws.send(JSON.stringify({ type: "subscribe_session", sessionId: OTHER }));
    await waitFor(
      () =>
        internals.sessionSubscribers.get(SID)?.size === 1 &&
        internals.sessionSubscribers.get(OTHER)?.size === 1,
    );
    expect(internals.sessionSubscribers.get(SID)?.size).toBe(1);

    // ── open: permission (screen path) + question (JSONL path) ──
    internals.sessionHandlers.handlePermissionChange(SID, detectGateScreen(GATE_SCREEN));
    internals.processJsonlQuestions(SID, [QUESTION_LINE]);
    await waitFor(() => types(a).includes("permission") && types(a).includes("question"));
    const livePermission = a.frames.find((f) => f.type === "permission");
    expect(livePermission?.gateId).toBeTruthy(); // positive control: A got the real event
    expect(types(a)).toContain("question");
    expect(
      a.frames.some(
        (frame) => frame.type === "prompt_event" && frame.prompt?.message === "Which language?",
      ),
    ).toBe(true);
    expect(prompts(b)).toEqual([]);
    expect(prompts(c)).toEqual([]);
    expect(JSON.stringify(b.frames)).not.toContain("rm -rf");
    expect(JSON.stringify(c.frames)).not.toContain("Which language?");
    expect(c.frames.some((frame) => frame.type === "prompt_event" && frame.sessionId === SID)).toBe(
      false,
    );

    // ── late subscriber: B gets both pending prompts from the replay ──
    b.ws.send(JSON.stringify({ type: "subscribe_session", sessionId: SID }));
    await waitFor(() => types(b).includes("permission") && types(b).includes("question"));
    const replayed = b.frames.find((f) => f.type === "permission");
    expect(replayed?.gateId).toBe(livePermission?.gateId); // same instance, not a new one
    expect(b.frames.find((f) => f.type === "question")?.toolUseId).toBe("toolu_scoped");
    expect(
      b.frames
        .find((frame) => frame.type === "prompt_snapshot")
        ?.prompts?.some((prompt) => prompt.message === "Which language?"),
    ).toBe(true);
    expect(prompts(c)).toEqual([]); // other session's subscriber still sees nothing

    // ── cancel: both subscribers, nobody else ──
    internals.cancelPendingQuestion(SID);
    internals.sessionHandlers.handlePermissionChange(SID, null);
    await waitFor(
      () =>
        types(a).includes("question_cancelled") &&
        types(a).includes("permission_cancelled") &&
        types(b).includes("question_cancelled") &&
        types(b).includes("permission_cancelled"),
    );
    expect(types(b)).toContain("question_cancelled");
    expect(types(b)).toContain("permission_cancelled");
    expect(prompts(c)).toEqual([]);

    // ── control: C's socket is alive — a global frame still reaches it ──
    internals.wsHub.broadcast({ type: "ping", ts: 1 });
    await waitFor(() => types(c).includes("ping"));
    expect(types(c)).toContain("ping");

    for (const cl of [a, b, c]) cl.ws.close();
  });
});
