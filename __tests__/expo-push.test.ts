import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository } from "../src/db/repositories/push.repository";
import { EXPO_PUSH_ENDPOINT, ExpoPushSender } from "../src/services/push/expoPushSender";
import { WaitingInputNotifier } from "../src/services/push/waitingInputNotifier";
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

/** Drive a full turn: the user prompts (→ running), the agent answers (→ waiting_input). */
async function runTurn(notifier: WaitingInputNotifier, s: ManagedSession = session()) {
  await notifier.onStatusChange({ ...s, status: "running" }, "waiting_input");
  await notifier.onStatusChange({ ...s, status: "waiting_input" }, "running");
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
    expect(outcome).toEqual({ attempted: 2, succeeded: 2, retired: 0 });
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

    expect(outcome).toEqual({ attempted: 2, succeeded: 1, retired: 1 });
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

    expect(outcome).toEqual({ attempted: 1, succeeded: 0, retired: 0 });
    expect(repo.get("ExponentPushToken[a]")?.failure_streak).toBe(1);
    expect(repo.listDeliverable()).toHaveLength(1);
  });

  it("records a failure per token when the whole request is rejected", async () => {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    repo.register({ token: "ExponentPushToken[b]", platform: "ios" });
    stubFetch([{ ok: false, status: 400 }]);

    const outcome = await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });

    expect(outcome).toEqual({ attempted: 2, succeeded: 0, retired: 0 });
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

    expect(outcome).toEqual({ attempted: 1, succeeded: 0, retired: 0 });
    expect(repo.get("ExponentPushToken[a]")?.last_failure_code).toBe("SendError");
  });

  it("sends no request when nothing is registered", async () => {
    const { fn } = stubFetch([{}]);
    const outcome = await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} });
    expect(fn).not.toHaveBeenCalled();
    expect(outcome).toEqual({ attempted: 0, succeeded: 0, retired: 0 });
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
  function notifier(watched: (id: string) => boolean = () => false) {
    repo.register({ token: "ExponentPushToken[a]", platform: "ios" });
    const { fn, calls } = stubFetch([{ body: { data: [{ status: "ok" }] } }]);
    return {
      notifier: new WaitingInputNotifier(new ExpoPushSender(repo), "srv-1", watched),
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
      title: "my-project",
      body: "Waiting for your input",
      data: { sessionId: "sess-1", serverId: "srv-1" },
    });
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

  it("does not notify when the session is being watched", async () => {
    const { notifier: n, fetch } = notifier((id) => id === "sess-1");

    await runTurn(n);

    expect(fetch).not.toHaveBeenCalled();
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
    const n = new WaitingInputNotifier(new ExpoPushSender(repo), "srv-1", () => false);

    await expect(runTurn(n)).resolves.toBeUndefined();
  });
});
