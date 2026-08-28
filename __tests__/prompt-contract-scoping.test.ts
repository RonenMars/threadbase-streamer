import type { WebSocket } from "ws";
import type { ApiDepsWiring } from "../src/server-wiring";
import { createApiDeps } from "../src/server-wiring";
import { PromptRegistry } from "../src/services/prompts/promptRegistry";
import { capabilitiesForPreset, type Principal } from "../src/services/security/capabilities";
import { WSHub } from "../src/ws-hub";

const SESSION = "prompt-session";

function promptDraft(sessionId = SESSION) {
  return {
    sessionId,
    intent: "question" as const,
    message: "Choose one",
    questions: [
      {
        text: "Choose one",
        inputMode: "single" as const,
        options: [{ label: "A" }, { label: "B" }],
        allowOther: false,
        secret: "unknown" as const,
      },
    ],
    answerRequirement: "unknown" as const,
    expiresAt: null,
    provenance: { source: "screen" as const, confidence: "inferred" as const },
  };
}

type FakeSocket = WebSocket & { frames: any[] };
function socket(): FakeSocket {
  const frames: any[] = [];
  return {
    OPEN: 1,
    readyState: 1,
    frames,
    send: (line: string) => frames.push(JSON.parse(line)),
    on: () => {},
    ping: () => {},
    terminate: () => {},
  } as unknown as FakeSocket;
}

const reader: Principal = {
  kind: "device",
  capabilities: capabilitiesForPreset("read-only"),
};

describe("provider-neutral prompt delivery", () => {
  it("delivers an unanswered prompt's terminal expiration event to its subscriber", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-26T12:00:00.000Z");
    try {
      const hub = new WSHub();
      const subscriber = socket();
      hub.addClient(subscriber);
      const subscribers = new Map<string, Set<WebSocket>>([[SESSION, new Set([subscriber])]]);
      const registry = new PromptRegistry({
        emit: (event) => hub.broadcastToClients(subscribers.get(event.sessionId) ?? [], event),
      });

      registry.open({
        ...promptDraft(),
        expiresAt: "2026-08-26T12:00:00.100Z",
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(subscriber.frames.map((frame) => frame.prompt.state)).toEqual(["open", "expired"]);
      registry.dispose();
      hub.dispose = () => {};
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the prompt snapshot synchronously before awaited terminal replay", async () => {
    let release: (lines: string[]) => void = () => {};
    const replay = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    let nextId = 0;
    const registry = new PromptRegistry({ createId: () => `opaque-id-${++nextId}` });
    registry.open(promptDraft());
    const ws = socket();
    const wiring = {
      wsHub: new WSHub(),
      addSessionSubscriber: vi.fn(),
      removeSessionSubscriber: vi.fn(),
      promptRegistry: registry,
      ptyManager: {
        hasSession: () => true,
        getOutputLines: () => replay,
        getInputHistory: () => [],
      },
      terminalSeq: new Map(),
      pendingPermission: new Map(),
      pendingQuestions: new Map(),
      sessionSubscribers: new Map(),
      wsToClientId: new Map(),
      clientIdToWs: new Map(),
      log: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
    } as unknown as ApiDepsWiring;
    const { handleWsMessage } = createApiDeps(wiring);

    const pending = Promise.resolve(
      handleWsMessage(
        ws,
        JSON.stringify({ type: "subscribe_session", sessionId: SESSION }),
        reader,
      ),
    );

    expect(ws.frames).toEqual([
      expect.objectContaining({ type: "prompt_snapshot", sessionId: SESSION, sequence: 1 }),
    ]);
    release(["terminal line"]);
    await pending;
    expect(ws.frames.map((frame) => frame.type)).toEqual(["prompt_snapshot", "terminal_replay"]);
  });

  it("publishes prompt content only to subscribers of that session", () => {
    const hub = new WSHub();
    const subscriber = socket();
    const unrelated = socket();
    hub.addClient(subscriber);
    hub.addClient(unrelated);
    const subscribers = new Map<string, Set<WebSocket>>([[SESSION, new Set([subscriber])]]);
    const registry = new PromptRegistry({
      emit: (event) => hub.broadcastToClients(subscribers.get(event.sessionId) ?? [], event),
    });

    registry.open(promptDraft());

    expect(subscriber.frames).toEqual([
      expect.objectContaining({
        type: "prompt_event",
        prompt: expect.objectContaining({ message: "Choose one" }),
      }),
    ]);
    expect(unrelated.frames).toEqual([]);
    hub.dispose = () => {};
  });
});
