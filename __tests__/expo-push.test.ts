import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository } from "../src/db/repositories/push.repository";
import { EXPO_PUSH_ENDPOINT, ExpoPushSender } from "../src/services/push/expoPushSender";
import {
  TURN_DONE_SETTLE_MS,
  WaitingInputNotifier,
} from "../src/services/push/waitingInputNotifier";
import type { ManagedSession } from "../src/types";

/**
 * "Your turn" notifications over Expo's relay (#528).
 *
 * The failure modes worth locking down are the silent ones: notifying twice for
 * one turn, notifying someone who is already reading the screen, retrying a
 * token whose device is gone, and letting one dead device silence every other
 * phone in the batch.
 */

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-expo-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    projectPath: "/tmp/proj",
    projectName: "my-project",
    branch: "main",
    status: "waiting_input",
    startedAt: new Date("2026-08-11T09:00:00Z"),
    completedAt: null,
    promptCount: 1,
    lastOutput: "sk-secret-token printed by the agent",
    sessionName: "fix the login bug",
    ...overrides,
  };
}

/** Stub `fetch` with one Expo response per call, in order. */
function stubFetch(responses: Array<{ ok?: boolean; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)] ?? {};
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body ?? { data: [] },
    };
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function bodyOf(call: { init: RequestInit }): Array<Record<string, unknown>> {
  return JSON.parse(String(call.init.body));
}

/** Let a scheduled "finished" push go out (WaitingInputNotifier tests fake setTimeout). */
async function settle() {
  await vi.advanceTimersByTimeAsync(TURN_DONE_SETTLE_MS);
  await new Promise((r) => setImmediate(r));
}

/**
 * Drive a full turn: the user prompts (→ running), the agent signals its turn
 * ended (→ waiting_input), and the end holds for the settle window.
 */
async function runTurn(notifier: WaitingInputNotifier, s: ManagedSession = session()) {
  await notifier.onStatusChange({ ...s, status: "running" }, "waiting_input");
  await notifier.onStatusChange(
    { ...s, status: "waiting_input", statusSource: "turn-signal" },
    "running",
  );
  await settle();
}

describe("ExpoPushSender", () => {
  it("sends one batched request carrying every deliverable token", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    repo.register({ token: "ExponentPushToken[b]", platform: "android" });
    const { fn, calls } = stubFetch([{ body: { data: [{ status: "ok" }, { status: "ok" }] } }]);

    const sender = new ExpoPushSender(repo);
    const outcome = await sender.send({ title: "p", body: "Waiting for your input", data: {} });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe(EXPO_PUSH_ENDPOINT);
    expect(bodyOf(calls[0]).map((m) => m.to)).toEqual([
      "ExponentPushToken[a]",
      "ExponentPushToken[b]",
    ]);
    expect(outcome).toEqual({ attempted: 2, succeeded: 2, retired: 0, suppressed: 0 });
  });

  it("never sends ActivityKit tokens to the relay", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    repo.register({ token: "apns-start", platform: "ios", kind: "liveactivity_start" });
    const { calls } = stubFetch([{ body: { data: [{ status: "ok" }] } }]);

    await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });

    expect(bodyOf(calls[0]).map((m) => m.to)).toEqual(["ExponentPushToken[a]"]);
  });

  it("evicts a DeviceNotRegistered token without blocking the others", async () => {
    repo.register({ token: "ExponentPushToken[dead]", platform: "ios" });
    repo.register({ token: "ExponentPushToken[live]", platform: "ios" });
    stubFetch([
      {
        body: {
          data: [
            {
              status: "error",
              message: "not registered",
              details: { error: "DeviceNotRegistered" },
            },
            { status: "ok" },
          ],
        },
      },
    ]);

    const outcome = await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });

    expect(outcome).toEqual({ attempted: 2, succeeded: 1, retired: 1, suppressed: 0 });
    expect(repo.get("ExponentPushToken[dead]")?.revoked_at).not.toBeNull();
    expect(repo.get("ExponentPushToken[live]")?.last_success_at).not.toBeNull();
    // Retired means gone from the next fan-out, not merely marked.
    expect(repo.listDeliverable().map((r) => r.token)).toEqual(["ExponentPushToken[live]"]);
  });

  it("keeps a transiently rejected token deliverable", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    stubFetch([
      { body: { data: [{ status: "error", details: { error: "MessageRateExceeded" } }] } },
    ]);

    const outcome = await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });

    expect(outcome).toEqual({ attempted: 1, succeeded: 0, retired: 0, suppressed: 0 });
    expect(repo.get("ExponentPushToken[a]")?.failure_streak).toBe(1);
    expect(repo.listDeliverable()).toHaveLength(1);
  });

  it("records a failure per token when the whole request is rejected", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    repo.register({ token: "ExponentPushToken[b]", platform: "ios" });
    stubFetch([{ ok: false, status: 400 }]);

    const outcome = await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });

    expect(outcome).toEqual({ attempted: 2, succeeded: 0, retired: 0, suppressed: 0 });
    expect(repo.get("ExponentPushToken[a]")?.last_failure_code).toBe("HTTP_400");
    expect(repo.get("ExponentPushToken[b]")?.last_failure_code).toBe("HTTP_400");
  });

  it("survives a network error without throwing", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const outcome = await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });

    expect(outcome).toEqual({ attempted: 1, succeeded: 0, retired: 0, suppressed: 0 });
    expect(repo.get("ExponentPushToken[a]")?.last_failure_code).toBe("SendError");
  });

  it("sends no request when nothing is registered", async () => {
    const { fn } = stubFetch([{}]);
    const outcome = await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });
    expect(fn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ attempted: 0, succeeded: 0, retired: 0, suppressed: 0 });
  });

  it("authorizes only when an access token is configured", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    const { calls } = stubFetch([{ body: { data: [{ status: "ok" }] } }]);

    await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();

    await new ExpoPushSender(repo, "expo-tok").send({ title: "p", body: "b", data: {} });
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer expo-tok");
  });
});

describe("WaitingInputNotifier", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function notifier() {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    const { fn, calls } = stubFetch([{ body: { data: [{ status: "ok" }] } }]);
    return {
      notifier: new WaitingInputNotifier(new ExpoPushSender(repo)),
      fetch: fn,
      calls,
    };
  }

  it("notifies when a turn the user started ends", async () => {
    const { notifier: n, fetch, calls } = notifier();

    await runTurn(n);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(calls[0])[0]).toEqual({
      to: "ExponentPushToken[a]",
      title: "✅ my-project",
      subtitle: "Claude finished",
      // A turn under a minute: no duration worth reading.
      body: "Tap to read the reply.",
      // No serverId: this token registered without one, and the streamer's own
      // hostname is not a name the app can resolve.
      data: { sessionId: "sess-1", kind: "turn_done" },
      // iOS is silent without a sound; the rest group and replace per session.
      sound: "default",
      priority: "high",
      threadId: "sess-1",
      collapseId: "sess-1",
      tag: "sess-1",
    });
  });

  // One phone, one push token, registered with every server it has paired. Each
  // server files the id the app uses for *it*, so a tap on this notification
  // opens the server that sent it rather than whichever the app lists first.
  it("routes each recipient to the server id it registered with", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios", clientServerId: "srv_aaa" });
    repo.register({ token: "ExponentPushToken[b]", platform: "ios", clientServerId: "srv_bbb" });
    repo.register({ token: "ExponentPushToken[old]", platform: "ios" });
    const { calls } = stubFetch([
      { body: { data: [{ status: "ok" }, { status: "ok" }, { status: "ok" }] } },
    ]);

    await runTurn(new WaitingInputNotifier(new ExpoPushSender(repo)));

    expect(bodyOf(calls[0]).map((m) => [m.to, m.data])).toEqual([
      ["ExponentPushToken[a]", { sessionId: "sess-1", kind: "turn_done", serverId: "srv_aaa" }],
      ["ExponentPushToken[b]", { sessionId: "sess-1", kind: "turn_done", serverId: "srv_bbb" }],
      // An older client registered no id: it gets none, and the app falls back
      // to its default server rather than to a name it cannot resolve.
      ["ExponentPushToken[old]", { sessionId: "sess-1", kind: "turn_done" }],
    ]);
  });

  it("writes each recipient's push in the language its app registered", async () => {
    repo.register({ token: "ExponentPushToken[he]", platform: "ios", locale: "he-IL" });
    repo.register({ token: "ExponentPushToken[ru]", platform: "android", locale: "ru" });
    repo.register({ token: "ExponentPushToken[fr]", platform: "ios", locale: "fr-FR" });
    repo.register({ token: "ExponentPushToken[old]", platform: "ios" });
    const { calls } = stubFetch([{ body: { data: Array(4).fill({ status: "ok" }) } }]);

    await runTurn(
      new WaitingInputNotifier(new ExpoPushSender(repo)),
      session({ provider: "codex-cli" }),
    );

    expect(bodyOf(calls[0]).map((m) => [m.subtitle, m.body])).toEqual([
      ["Codex סיים", "הקישו כדי לקרוא את התשובה."],
      // Android has no subtitle: the event leads the body instead.
      [undefined, "Codex закончил. Нажмите, чтобы прочитать ответ."],
      // A language the app does not ship, and a client that sent none: English.
      ["Codex finished", "Tap to read the reply."],
      ["Codex finished", "Tap to read the reply."],
    ]);
  });

  it("pushes once when a permission gate opens, however often it repaints", async () => {
    const { notifier: n, fetch, calls } = notifier();
    await n.onStatusChange(session({ status: "running" }), "waiting_input");

    await n.onPrompt(session(), "permission", true);
    await n.onPrompt(session(), "permission", true); // cursor moved / repaint

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(calls[0])[0]).toMatchObject({
      title: "✋ my-project",
      subtitle: "Claude needs your approval",
      body: "Paused until you answer.",
      data: { sessionId: "sess-1", kind: "permission" },
    });
  });

  it("says how long the turn ran", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { notifier: n, calls } = notifier();
    await n.onStatusChange(session({ status: "running" }), "waiting_input");
    vi.setSystemTime(Date.now() + 12 * 60_000 + 30_000);
    await n.onStatusChange(
      session({ status: "waiting_input", statusSource: "turn-signal" }),
      "running",
    );
    await settle();

    expect(bodyOf(calls[0])[0].body).toBe("Worked for 12 min.");
  });

  it("names the branch, so two sessions of one project differ", async () => {
    const { notifier: n, calls } = notifier();

    await runTurn(n, session({ branch: "fix/login" }));

    expect(bodyOf(calls[0])[0].title).toBe("✅ my-project · fix/login");
  });

  it("says what a gate asks for, and which option count a question has", async () => {
    const { notifier: n, calls } = notifier();

    await n.onPrompt(session(), "permission", true, { action: "command" });
    await n.onPrompt(session(), "permission", false);
    await n.onPrompt(session(), "question", true, { optionCount: 3 });

    expect(calls.map((c) => [bodyOf(c)[0].subtitle, bodyOf(c)[0].body])).toEqual([
      ["Claude wants to run a command", "Paused until you answer."],
      ["Claude asked a question", "3 options — paused until you pick one."],
    ]);
  });

  it("sends a usage limit as its own kind, with the reset time", async () => {
    const { notifier: n, calls } = notifier();

    await n.onPrompt(session({ provider: "codex-cli" }), "limited", true, { resetsAt: "3:45 PM" });

    expect(bodyOf(calls[0])[0]).toMatchObject({
      title: "⏳ my-project",
      subtitle: "Codex hit its usage limit",
      body: "Resets at 3:45 PM. Paused until then.",
      data: { sessionId: "sess-1", kind: "limited" },
    });
  });

  it("pushes again for the next gate, and still for the turn's end", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    const { fn: fetch, calls } = stubFetch([{ body: { data: [{ status: "ok" }] } }]);
    const n = new WaitingInputNotifier(new ExpoPushSender(repo));
    await n.onStatusChange(session({ status: "running" }), "waiting_input");

    await n.onPrompt(session(), "permission", true);
    await n.onPrompt(session(), "permission", false); // answered
    await n.onPrompt(session(), "question", true);
    await n.onStatusChange(
      session({ status: "waiting_input", statusSource: "turn-signal" }),
      "running",
    );
    await settle();

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => (bodyOf(c)[0].data as { kind: string }).kind)).toEqual([
      "permission",
      "question",
      "turn_done",
    ]);
  });

  it("says which session, never what the agent said", async () => {
    const { notifier: n, calls } = notifier();

    await runTurn(n);

    // The Live Activity payload carries lastOutput and a prompt-derived name,
    // which is the divergence from the privacy policy in threadbase-mobile#636.
    // This payload must not repeat it.
    const raw = String(calls[0].init.body);
    expect(raw).not.toContain("sk-secret-token");
    expect(raw).not.toContain("fix the login bug");
  });

  // #962: each of these settled a turn one to two seconds after the submit,
  // while the agent was still working, and each sent "finished".
  it.each(["prompt-marker", "screen-marker", "quiet-fallback", "timeout-fallback"] as const)(
    "does not push a turn end the runner only guessed (%s)",
    async (statusSource) => {
      const { notifier: n, fetch } = notifier();

      await n.onStatusChange(session({ status: "running" }), "waiting_input");
      await n.onStatusChange(session({ status: "waiting_input", statusSource }), "running");
      await settle();

      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("holds 'finished' for the settle window, and drops it if the turn resumes", async () => {
    const { notifier: n, fetch } = notifier();
    const ended = session({ status: "waiting_input", statusSource: "turn-signal" });

    await n.onStatusChange(session({ status: "running" }), "waiting_input");
    await n.onStatusChange(ended, "running");
    await vi.advanceTimersByTimeAsync(TURN_DONE_SETTLE_MS - 1);
    expect(fetch).not.toHaveBeenCalled();

    // Back to work inside the window (the user sent more, or the runner re-read).
    await n.onStatusChange(session({ status: "running" }), "waiting_input");
    await settle();
    expect(fetch).not.toHaveBeenCalled();

    // That second turn's own end is still reported.
    await n.onStatusChange(ended, "running");
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending 'finished' with the gate that opened inside the window", async () => {
    const { notifier: n, fetch, calls } = notifier();

    await n.onStatusChange(session({ status: "running" }), "waiting_input");
    await n.onStatusChange(
      session({ status: "waiting_input", statusSource: "turn-signal" }),
      "running",
    );
    await n.onPrompt(session(), "permission", true);
    await settle();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((bodyOf(calls[0])[0].data as { kind: string }).kind).toBe("permission");
  });

  it("does not notify on boot ready, before the user has prompted", async () => {
    const { notifier: n, fetch } = notifier();

    // Spawn goes straight to running, then markReady settles it.
    await n.onStatusChange(session({ status: "waiting_input" }), "running");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("notifies once per turn when ready is detected twice", async () => {
    const { notifier: n, fetch } = notifier();

    await runTurn(n);
    // A second detector firing after the first already settled the session:
    // the store's status is waiting_input by now, so previousStatus is too.
    await n.onStatusChange(session({ status: "waiting_input" }), "waiting_input");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops an open turn when the PTY dies", async () => {
    const { notifier: n, fetch } = notifier();

    await n.onStatusChange(session({ status: "running" }), "waiting_input");
    await n.onStatusChange(session({ status: "idle" }), "running");
    await n.onStatusChange(session({ status: "waiting_input" }), "running");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a send failure from surfacing as a transition failure", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("relay down");
      }),
    );
    const n = new WaitingInputNotifier(new ExpoPushSender(repo));

    await expect(runTurn(n)).resolves.toBeUndefined();
  });
});
