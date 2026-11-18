import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushRepository } from "../src/db/repositories/push.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { ExpoPushSender } from "../src/services/push/expoPushSender";
import {
  EXTERNAL_TURN_MAX_AGE_MS,
  ExternalTurnNotifier,
} from "../src/services/push/externalTurnNotifier";
import { SUBSCRIPTION_UNUSED_MS, sweepPushTokens } from "../src/services/push/pushTokenRetention";

/**
 * Turn-end pushes for an external session (#1265): a device subscribes to one
 * conversation and is told when that conversation's turn ends. Real runtime.db
 * and PushRepository, stubbed fetch, injected clock.
 */

vi.mock("../src/logger", () => {
  const fake = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    log: () => {},
    pino: { isLevelEnabled: () => false },
  };
  return { getLogger: () => fake, logger: fake };
});

const CONV = "11111111-2222-3333-4444-555555555555";
const NOW = Date.parse("2026-11-15T10:00:00Z");

let dir: string;
let store: RuntimeStore;
let repo: PushRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-ext-sub-"));
  store = RuntimeStore.open(join(dir, "runtime.db"));
  repo = new PushRepository(store.getDatabase());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function stubFetch() {
  const bodies: Array<Array<Record<string, any>>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)) as Array<Record<string, any>>;
      bodies.push(batch);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: batch.map(() => ({ status: "ok", id: "t" })) }),
      };
    }),
  );
  return bodies;
}

const claudeEnd = (iso: string) =>
  JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: iso, durationMs: 5 });
const codexEnd = (iso: string) =>
  JSON.stringify({
    type: "event_msg",
    timestamp: iso,
    payload: { type: "task_complete", turn_id: "t1", root_turn_id: "t1" },
  });

describe("subscription storage", () => {
  beforeEach(() => {
    repo.register({ token: "tok-a", platform: "ios" });
    repo.register({ token: "tok-b", platform: "ios" });
  });

  it("refuses a token that is not registered and stores nothing", () => {
    expect(repo.subscribe("tok-missing", CONV, NOW)).toBe(false);
    expect(repo.subscribedTokens(CONV).size).toBe(0);
  });

  it("is idempotent and refreshes touched_at on a repeat", () => {
    expect(repo.subscribe("tok-a", CONV, NOW)).toBe(true);
    expect(repo.subscribe("tok-a", CONV, NOW + 5_000)).toBe(true);
    expect([...repo.subscribedTokens(CONV)]).toEqual(["tok-a"]);
    // Not yet stale at NOW + 5s, stale once the cutoff passes the refresh.
    expect(repo.pruneSubscriptions(NOW + 1_000)).toBe(0);
    expect(repo.pruneSubscriptions(NOW + 6_000)).toBe(1);
  });

  it("keeps subscriptions per conversation and per token", () => {
    repo.subscribe("tok-a", CONV, NOW);
    repo.subscribe("tok-b", "other-conv", NOW);
    expect([...repo.subscribedTokens(CONV)]).toEqual(["tok-a"]);
    expect(repo.hasSubscribers(CONV)).toBe(true);
    expect(repo.hasSubscribers("nobody")).toBe(false);
  });

  it("unsubscribes one pair and reports whether it existed", () => {
    repo.subscribe("tok-a", CONV, NOW);
    expect(repo.unsubscribe("tok-b", CONV)).toBe(false);
    expect(repo.unsubscribe("tok-a", CONV)).toBe(true);
    expect(repo.hasSubscribers(CONV)).toBe(false);
  });

  it("leaves nothing behind when the token is unregistered", () => {
    repo.subscribe("tok-a", CONV, NOW);
    repo.deleteToken("tok-a");
    expect(repo.hasSubscribers(CONV)).toBe(false);
  });

  it("prunes only subscriptions untouched since the cutoff", () => {
    repo.subscribe("tok-a", CONV, NOW);
    repo.subscribe("tok-b", CONV, NOW + 10_000);
    expect(repo.pruneSubscriptions(NOW + 5_000)).toBe(1);
    expect([...repo.subscribedTokens(CONV)]).toEqual(["tok-b"]);
  });
});

describe("retention sweep", () => {
  it("prunes subscriptions untouched for SUBSCRIPTION_UNUSED_MS and keeps newer ones", () => {
    repo.register({ token: "tok-a", platform: "ios" });
    repo.subscribe("tok-a", "old-conv", NOW - SUBSCRIPTION_UNUSED_MS - 1_000);
    repo.subscribe("tok-a", "new-conv", NOW - SUBSCRIPTION_UNUSED_MS + 1_000);

    const result = sweepPushTokens(repo, NOW);

    expect(repo.hasSubscribers("old-conv")).toBe(false);
    expect(repo.hasSubscribers("new-conv")).toBe(true);
    // The token sweep's own return shape is unchanged.
    expect(result).toEqual({ dead: 0, unused: 0 });
  });
});

describe("ExpoPushSender only", () => {
  it("delivers to the named tokens alone, and counts the rest as neither attempted nor suppressed", async () => {
    repo.register({ token: "tok-a", platform: "ios" });
    repo.register({ token: "tok-b", platform: "ios" });
    const bodies = stubFetch();

    const outcome = await new ExpoPushSender(repo).send(() => ({ title: "t", body: "b" }), {
      only: new Set(["tok-b"]),
    });

    expect(bodies.flat().map((m) => m.to)).toEqual(["tok-b"]);
    expect(outcome).toMatchObject({ attempted: 1, suppressed: 0 });
  });

  it("sends nothing for an empty set rather than falling back to everyone", async () => {
    repo.register({ token: "tok-a", platform: "ios" });
    const bodies = stubFetch();

    const outcome = await new ExpoPushSender(repo).send(() => ({ title: "t", body: "b" }), {
      only: new Set(),
    });

    expect(bodies).toHaveLength(0);
    expect(outcome.attempted).toBe(0);
  });
});

describe("ExternalTurnNotifier", () => {
  function setup(provider: "claude-code" | "codex-cli" = "claude-code", clock = NOW) {
    const meta = vi.fn((id: string) =>
      id === CONV ? { provider, projectName: "my-project", branch: "feat/x" } : null,
    );
    const notifier = new ExternalTurnNotifier({
      sender: new ExpoPushSender(repo),
      repo,
      meta,
      now: () => clock,
    });
    return { notifier, meta };
  }

  beforeEach(() => {
    repo.register({ token: "tok-a", platform: "ios" });
    repo.register({ token: "tok-b", platform: "ios" });
    repo.subscribe("tok-a", CONV, NOW);
  });

  it("pushes one turn_done to the subscribed device only, naming the conversation", async () => {
    const bodies = stubFetch();
    const { notifier } = setup();

    await notifier.onLines(CONV, [claudeEnd("2026-11-15T09:59:50Z")]);

    const sent = bodies.flat();
    expect(sent.map((m) => m.to)).toEqual(["tok-a"]);
    expect(sent[0].data).toMatchObject({ sessionId: CONV, kind: "turn_done" });
    expect(sent[0].title).toContain("my-project");
  });

  it("does nothing for a conversation nobody subscribed to, without reading its metadata", async () => {
    const bodies = stubFetch();
    const { notifier, meta } = setup();

    await notifier.onLines("someone-elses", [claudeEnd("2026-11-15T09:59:50Z")]);

    expect(bodies).toHaveLength(0);
    expect(meta).not.toHaveBeenCalled();
  });

  it("does nothing for a batch with no turn end", async () => {
    const bodies = stubFetch();
    const { notifier } = setup();

    await notifier.onLines(CONV, [JSON.stringify({ type: "assistant", timestamp: "x" })]);

    expect(bodies).toHaveLength(0);
  });

  it("sends once when the same turn end arrives again", async () => {
    const bodies = stubFetch();
    const { notifier } = setup();
    const line = claudeEnd("2026-11-15T09:59:50Z");

    await notifier.onLines(CONV, [line]);
    await notifier.onLines(CONV, [line]);

    expect(bodies.flat()).toHaveLength(1);
  });

  it("sends again for the next turn", async () => {
    const bodies = stubFetch();
    const { notifier } = setup();

    await notifier.onLines(CONV, [claudeEnd("2026-11-15T09:58:00Z")]);
    await notifier.onLines(CONV, [claudeEnd("2026-11-15T09:59:50Z")]);

    expect(bodies.flat()).toHaveLength(2);
  });

  it("ignores a turn end older than the freshness window, which is a replay", async () => {
    const bodies = stubFetch();
    const { notifier } = setup();
    const old = new Date(NOW - EXTERNAL_TURN_MAX_AGE_MS - 1_000).toISOString();

    await notifier.onLines(CONV, [claudeEnd(old)]);

    expect(bodies).toHaveLength(0);
  });

  it("reads Codex's end line with the Codex parser", async () => {
    const bodies = stubFetch();
    const { notifier } = setup("codex-cli");

    await notifier.onLines(CONV, [codexEnd("2026-11-15T09:59:50Z")]);

    expect(bodies.flat()).toHaveLength(1);
  });

  it("does not read a Codex end line as a Claude one", async () => {
    const bodies = stubFetch();
    const { notifier } = setup("claude-code");

    await notifier.onLines(CONV, [codexEnd("2026-11-15T09:59:50Z")]);

    expect(bodies).toHaveLength(0);
  });

  it("respects the device's own preferences", async () => {
    const bodies = stubFetch();
    repo.setPrefs("tok-a", { waitingInput: false, sessionFailed: true }, null);
    const { notifier } = setup();

    await notifier.onLines(CONV, [claudeEnd("2026-11-15T09:59:50Z")]);

    expect(bodies).toHaveLength(0);
  });

  it("keeps the subscription alive by touching it when a push goes out", async () => {
    stubFetch();
    const later = NOW + 20 * 86_400_000;
    const { notifier } = setup("claude-code", later);

    await notifier.onLines(CONV, [claudeEnd(new Date(later - 5_000).toISOString())]);

    // Created 20 days ago, touched by the push: a 14 day cutoff must not take it.
    expect(repo.pruneSubscriptions(later - 14 * 86_400_000)).toBe(0);
    expect(repo.hasSubscribers(CONV)).toBe(true);
  });

  it("never throws into the tail path when the send fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { notifier } = setup();

    await expect(
      notifier.onLines(CONV, [claudeEnd("2026-11-15T09:59:50Z")]),
    ).resolves.toBeUndefined();
  });
});
