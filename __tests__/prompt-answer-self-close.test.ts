import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamerServer } from "../src/server";
import type { PromptRegistry } from "../src/services/prompts/promptRegistry";
import {
  type PermissionGate,
  permissionGateKey,
} from "../src/services/questions/detectPermissionGate";

// A real PTYManager over a fake child process. Nothing about the detector, the
// registry, the handlers or the route is stubbed: the gate is painted through
// the real scraper, and `sendKeys` is the real one, so its close-on-answer
// (pty-manager's isPermissionAnswer branch) fires for real. That branch is the
// whole defect, and `prompt-answer-pty.test.ts` cannot see it because it
// REPLACES ptyManager.sendKeys with a bare write.
vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 4242,
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

const API_KEY = "tb_prompt_selfclose_key_000000000";

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

// A DIFFERENT gate, for the replaced-mid-answer control.
const OTHER_GATE_PAINT = [
  "╭────────────────────────────────────────────────────╮",
  "│ Bash command                                       │",
  "│   rm -rf build                                     │",
  "│ This command requires approval                     │",
  "│                                                    │",
  "│ Do you want to proceed?                            │",
  "│ ❯ 1. Yes                                           │",
  "│   2. No                                            │",
  "│                                                    │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain   │",
  "╰────────────────────────────────────────────────────╯",
].join("\r\n");

// What the PTY streams once the turn moves on and the box is genuinely gone:
// erase-screen, unrelated output, then Claude's own input box back. No gate
// footer and no Yes/No labels, so neither gate detector matches, but the ╭
// prompt marker is present — which is what pty-manager requires before it will
// believe a previously-open gate has closed.
const GATE_GONE = `\x1b[2J\x1b[H${[
  "⏺ Done.",
  "  ⎿  nothing to approve here",
  "",
  "╭────────────────────────────────────────────────────╮",
  "│ >                                                  │",
  "╰────────────────────────────────────────────────────╯",
].join("\r\n")}`;

const settle = () => new Promise((r) => setTimeout(r, 20));
// Past SCRAPE_THROTTLE_MS (300), so the next chunk runs a full detection pass.
const settlePastThrottle = () => new Promise((r) => setTimeout(r, 350));

type MockProc = { _emit: (e: string, d: string) => void; write: ReturnType<typeof vi.fn> };

// The server holds a LiveSessionManager that delegates to a per-provider
// runner; the Claude runner is the real PTYManager whose sendKeys carries the
// close-on-answer branch. Sessions are started on that runner directly so the
// provider-installed assertion (which wants a real claude binary) stays out of
// the way — every call the handlers make still goes through the delegator.
interface ClaudeRunner {
  startFresh: (o: { projectPath: string; projectName: string }) => Promise<{ id: string }>;
  sessions: Map<string, { process: MockProc }>;
}

interface Internals {
  promptRegistry: PromptRegistry;
  ptyManager: {
    runners: Map<string, ClaudeRunner>;
    getOutputLines: (sessionId: string, lines: number) => Promise<string[]>;
  };
  wsHub: { broadcastToClients: (clients: unknown, message: unknown) => void };
  sessionHandlers: {
    pendingPermission: Map<string, PermissionGate & { gateId: string; promptId?: string }>;
  };
}

interface Harness {
  server: StreamerServer;
  internal: Internals;
  sessionId: string;
  proc: MockProc;
  messages: { type: string; [k: string]: unknown }[];
  post: (body: unknown) => Promise<Response>;
  prompt: () => ReturnType<PromptRegistry["get"]>;
  promptId: string;
  questionId: string;
  optionIds: string[];
  answerFor: (optionIndex: number, idempotencyKey: string) => Record<string, unknown>;
}

async function openHarness(): Promise<Harness> {
  const server = new StreamerServer({
    port: 0,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    skipStartupWarmup: true,
    cacheDir: mkdtempSync(join(tmpdir(), "tb-prompt-selfclose-")),
    scanProfiles: [],
  });
  await server.listen(0);
  const internal = server as unknown as Internals;

  // Spy on the one choke point every broadcast goes through, so the ORDER of
  // permission_cancelled vs prompt_event is observable (message is arg[1]).
  const messages: { type: string; [k: string]: unknown }[] = [];
  const realBroadcast = internal.wsHub.broadcastToClients.bind(internal.wsHub);
  internal.wsHub.broadcastToClients = (clients: unknown, message: unknown) => {
    messages.push(message as { type: string });
    return realBroadcast(clients, message);
  };

  const runner = internal.ptyManager.runners.get("claude-code");
  if (!runner) throw new Error("claude runner missing");
  const session = await runner.startFresh({
    projectPath: "/tmp/tb-selfclose",
    projectName: "selfclose",
  });
  const sessionId = session.id;
  const started = runner.sessions.get(sessionId);
  if (!started) throw new Error("session did not start");
  const proc = started.process;

  proc._emit("data", GATE_PAINT);
  await settle();

  // Positive control on the SETUP: the gate really is open and normalized
  // before anything is answered. Every assertion below is void without it.
  const opened = internal.promptRegistry.snapshot(sessionId).prompts.at(-1);
  expect(opened?.state).toBe("open");
  expect(opened?.questions[0].options).toHaveLength(3);
  if (!opened) throw new Error("gate did not normalize");
  const promptId = opened.promptId;
  const questionId = opened.questions[0].questionId;
  const optionIds = opened.questions[0].options.map((option) => option.optionId);
  messages.length = 0;
  proc.write.mockClear();

  const post = (body: unknown) =>
    fetch(`http://localhost:${server.port}/api/sessions/${sessionId}/prompt/answer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const prompt = () => internal.promptRegistry.get(promptId);
  const answerFor = (optionIndex: number, idempotencyKey: string) => ({
    promptId,
    revision: 1,
    responses: [{ questionId, optionIds: [optionIds[optionIndex]] }],
    idempotencyKey,
  });

  return {
    server,
    internal,
    sessionId,
    proc,
    messages,
    post,
    prompt,
    promptId,
    questionId,
    optionIds,
    answerFor,
  };
}

describe("/prompt/answer on a scraped gate our own write closes", () => {
  // T1 — the defect. Fails on origin/main@7cde4b9a with 409 prompt_cancelled.
  it("settles 200 resolved when our own answer keys close the scraped gate", async () => {
    const h = await openHarness();
    try {
      const response = await h.post(h.answerFor(0, "self-close-accepted"));
      const body = (await response.json()) as { ok: boolean; prompt?: { state: string } };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);

      const record = h.prompt();
      expect(record?.state).toBe("resolved");
      expect(record?.terminalReason).toBe("answered");

      // The bytes landed, exactly once, and they are this gate's answer.
      expect(h.proc.write).toHaveBeenCalledTimes(1);
      expect(h.proc.write).toHaveBeenCalledWith("1\r");

      // Ruled wire shape: the legacy cancel still goes out, and the contract
      // sees EXACTLY ONE terminal prompt_event, resolved, never cancelled.
      const terminal = h.messages.filter(
        (m) =>
          m.type === "prompt_event" &&
          ["resolved", "cancelled", "expired", "unavailable"].includes(
            (m.prompt as { state: string }).state,
          ),
      );
      expect(terminal).toHaveLength(1);
      expect((terminal[0].prompt as { state: string }).state).toBe("resolved");

      const legacyAt = h.messages.findIndex((m) => m.type === "permission_cancelled");
      const resolvedAt = h.messages.indexOf(terminal[0]);
      expect(legacyAt).toBeGreaterThanOrEqual(0);
      expect(legacyAt).toBeLessThan(resolvedAt);

      // The 200 body and the resolved event are the same transition.
      expect(body.prompt?.state).toBe("resolved");
      expect((terminal[0].prompt as { revision: number }).revision).toBe(record?.revision);

      // Reconnect inside the terminal retention window finds it resolved.
      const snapshot = h.internal.promptRegistry.snapshot(h.sessionId).prompts;
      expect(snapshot.find((p) => p.promptId === h.promptId)?.state).toBe("resolved");
    } finally {
      await h.server.close();
    }
  });

  // T2 — positive control on the HARNESS: it can produce a genuine cancel, and
  // the route still reports one. Without this, T1's 200 could just mean the
  // harness never cancels anything, which is exactly how #700 shipped green.
  it("still reports a gate the provider closed on its own as cancelled", async () => {
    const h = await openHarness();
    try {
      await settlePastThrottle();
      h.proc._emit("data", GATE_GONE);
      await settle();
      expect(h.prompt()?.state).toBe("cancelled");
      expect(h.prompt()?.terminalReason).toBe("provider_closed");

      const response = await h.post(h.answerFor(0, "genuine-cancel"));

      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("prompt_cancelled");
      expect(h.proc.write).not.toHaveBeenCalled();
    } finally {
      await h.server.close();
    }
  });

  // T3 — a cancel NOT caused by our write, arriving mid-answer, still wins.
  // Also guarded by the adapter's own gate-identity check, so it is a
  // regression test rather than the falsifiable control (that is T4).
  it("fails an answer whose gate was replaced by a different gate mid-answer", async () => {
    const h = await openHarness();
    try {
      // The one instrumented seam: getOutputLines is already async and already
      // awaited inside permissionGateStillOpen, BEFORE the write. Firing the
      // replacing paint from there interleaves a real detector transition into
      // the answer. The transition itself is real registry work through the
      // real handler; nothing under test is faked.
      const realGetLines = h.internal.ptyManager.getOutputLines.bind(h.internal.ptyManager);
      let fired = false;
      h.internal.ptyManager.getOutputLines = async (sessionId: string, lines: number) => {
        if (!fired) {
          fired = true;
          await settlePastThrottle();
          h.proc._emit("data", `\x1b[2J\x1b[H${OTHER_GATE_PAINT}`);
          await settle();
        }
        return realGetLines(sessionId, lines);
      };

      const response = await h.post(h.answerFor(0, "replaced-mid-answer"));

      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("prompt_cancelled");
      expect(h.prompt()?.state).toBe("cancelled");
      expect(h.prompt()?.terminalReason).toBe("replaced");
      expect(h.proc.write).not.toHaveBeenCalled();
    } finally {
      await h.server.close();
    }
  });

  // T4 — THE negative control. The session dies mid-answer, the bytes still
  // land, and the answer must NOT be reported as settled. This is the one a
  // too-broad suppression breaks (mutation M2), which is what gives it teeth.
  it("fails an answer when the session ends mid-answer, even though bytes landed", async () => {
    const h = await openHarness();
    try {
      const realGetLines = h.internal.ptyManager.getOutputLines.bind(h.internal.ptyManager);
      let fired = false;
      h.internal.ptyManager.getOutputLines = async (sessionId: string, lines: number) => {
        if (!fired) {
          fired = true;
          h.internal.promptRegistry.invalidateSession(h.sessionId, "session_ended");
        }
        return realGetLines(sessionId, lines);
      };

      const response = await h.post(h.answerFor(0, "session-died-mid-answer"));

      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("prompt_unavailable");
      expect(h.prompt()?.state).toBe("unavailable");
      expect(h.prompt()?.terminalReason).toBe("session_ended");
      // The bytes DID land — this is precisely the case that must still fail.
      expect(h.proc.write).toHaveBeenCalledTimes(1);
    } finally {
      await h.server.close();
    }
  });

  // T5 — the pre-adapter validation boundary (probe row 2b). A pinning test:
  // green before the change and after it. Proves the in-flight marker did not
  // drag validation across the write.
  it("refuses invalid answers before the adapter, writing zero bytes", async () => {
    const h = await openHarness();
    try {
      const base = { promptId: h.promptId, revision: 1 };

      const unknownOption = await h.post({
        ...base,
        responses: [{ questionId: h.questionId, optionIds: ["not-an-option-id"] }],
        idempotencyKey: "row2b-unknown-option",
      });
      const foreignOption = await h.post({
        ...base,
        responses: [{ questionId: h.questionId, optionIds: [h.questionId] }],
        idempotencyKey: "row2b-foreign-option",
      });
      const unknownQuestion = await h.post({
        ...base,
        responses: [{ questionId: "fabricated-question-id", optionIds: [h.optionIds[0]] }],
        idempotencyKey: "row2b-unknown-question",
      });
      // Empty optionIds never reaches the registry: OptionResponseSchema has
      // .min(1), so the route's own parse refuses it first. Still pre-adapter,
      // still zero bytes — just a different layer than the other three.
      const emptyOptions = await h.post({
        ...base,
        responses: [{ questionId: h.questionId, optionIds: [] }],
        idempotencyKey: "row2b-empty-options",
      });
      // The shape that DOES reach validateResponses' single-select guard.
      const multiSelect = await h.post({
        ...base,
        responses: [{ questionId: h.questionId, optionIds: [h.optionIds[0], h.optionIds[1]] }],
        idempotencyKey: "row2b-multi-select",
      });

      expect(unknownOption.status).toBe(400);
      expect((await unknownOption.json()).code).toBe("unknown_option");
      expect(foreignOption.status).toBe(400);
      expect((await foreignOption.json()).code).toBe("unknown_option");
      expect(unknownQuestion.status).toBe(400);
      expect((await unknownQuestion.json()).code).toBe("unknown_question");
      expect(emptyOptions.status).toBe(400);
      expect((await emptyOptions.json()).code).toBe("invalid_prompt_answer");
      expect(multiSelect.status).toBe(400);
      expect((await multiSelect.json()).code).toBe("unsupported_prompt_shape");

      // Zero bytes, and the record is untouched at its original revision.
      expect(h.proc.write).not.toHaveBeenCalled();
      expect(h.prompt()?.state).toBe("open");
      expect(h.prompt()?.revision).toBe(1);
    } finally {
      await h.server.close();
    }
  });

  // T6 — the legacy route, same root cause, same primitive. Its 200 never
  // consulted the registry, so the cancelled record was invisible.
  it("leaves the record resolved when the legacy permission route answers", async () => {
    const h = await openHarness();
    try {
      const gate = h.internal.sessionHandlers.pendingPermission.get(h.sessionId);
      if (!gate) throw new Error("pending gate missing");
      const response = await fetch(
        `http://localhost:${h.server.port}/api/sessions/${h.sessionId}/permission/answer`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            contentKey: permissionGateKey(gate),
            optionIndex: 0,
            gateId: gate.gateId,
          }),
        },
      );

      expect(response.status).toBe(200);
      expect((await response.json()).ok).toBe(true);
      expect(h.proc.write).toHaveBeenCalledTimes(1);
      expect(h.prompt()?.state).toBe("resolved");
      expect(h.prompt()?.terminalReason).toBe("answered_legacy");
    } finally {
      await h.server.close();
    }
  });
});
