import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "fs";
import { Hono } from "hono";
import type { Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/api/app";
import { createMiscRoutes } from "../src/api/routes/misc.routes";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository } from "../src/db/repositories/push.repository";
import type { NotificationPrefs } from "../src/schemas/notification-prefs.schema";
import { EXPO_PUSH_ENDPOINT, ExpoPushSender } from "../src/services/push/expoPushSender";
import {
  TURN_DONE_SETTLE_MS,
  WaitingInputNotifier,
} from "../src/services/push/waitingInputNotifier";
import type { ManagedSession } from "../src/types";

/**
 * Server-enforced notification preferences.
 *
 * The settings screen used to keep every toggle on the phone, so none of them
 * changed what the server sent. What is worth locking down is the silent
 * failure: a toggle stored but not applied, a preference change that wipes
 * delivery health, one device's quiet hours muting another phone, and a failed
 * push firing for a session that merely ended. Every "not sent" assertion sits
 * next to a "sent" one built from the same setup.
 */

const EXPO_A = "ExponentPushToken[a]";
const EXPO_B = "ExponentPushToken[b]";

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-prefs-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const ON: NotificationPrefs = { waitingInput: true, sessionFailed: true };
/** Quiet at every hour of every day, in UTC, so the tests do not depend on the clock. */
const ALWAYS_QUIET: NotificationPrefs = {
  ...ON,
  quietHours: { enabled: true, tz: "UTC", default: { from: "00:00", to: "23:59" } },
};

/** Stub Expo, but let requests to the local test server through. */
function stubExpo(responses: Array<{ status?: number; body?: unknown }> = []) {
  const real = globalThis.fetch;
  const calls: Array<{ body: Array<Record<string, unknown>> }> = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url === EXPO_PUSH_ENDPOINT) {
      calls.push({ body: JSON.parse(String(init?.body)) });
      const r = responses[Math.min(i++, responses.length - 1)] ?? {};
      const sent = calls.at(-1)?.body ?? [];
      return {
        ok: (r.status ?? 200) < 400,
        status: r.status ?? 200,
        json: async () => r.body ?? { data: sent.map(() => ({ status: "ok" })) },
      };
    }
    return real(url, init);
  });
  return calls;
}

const sentTo = (calls: Array<{ body: Array<Record<string, unknown>> }>) =>
  calls.flatMap((c) => c.body.map((m) => m.to));

function session(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    projectPath: "/tmp/proj",
    projectName: "my-project",
    branch: "main",
    status: "waiting_input",
    startedAt: new Date("2026-09-19T09:00:00Z"),
    completedAt: null,
    promptCount: 1,
    lastOutput: "",
    ...over,
  };
}

describe("PushRepository preferences", () => {
  it("stores preferences at registration", () => {
    repo.register({ token: EXPO_A, platform: "ios", notificationPrefs: ALWAYS_QUIET });
    expect(JSON.parse(repo.get(EXPO_A)?.notification_prefs ?? "null")).toEqual(ALWAYS_QUIET);
  });

  it("keeps stored preferences when a later registration carries none", () => {
    repo.register({ token: EXPO_A, platform: "ios", notificationPrefs: ALWAYS_QUIET });
    repo.register({ token: EXPO_A, platform: "ios" });
    expect(JSON.parse(repo.get(EXPO_A)?.notification_prefs ?? "null")).toEqual(ALWAYS_QUIET);
  });

  it("setPrefs replaces preferences without touching delivery health", () => {
    repo.register({ token: EXPO_A, platform: "ios" });
    repo.recordFailure(EXPO_A, "SendError");
    repo.recordFailure(EXPO_A, "SendError");

    expect(repo.setPrefs(EXPO_A, ALWAYS_QUIET, null)).toBe(true);

    const row = repo.get(EXPO_A);
    expect(JSON.parse(row?.notification_prefs ?? "null")).toEqual(ALWAYS_QUIET);
    // The reason this is not a re-register: that would reset the streak to 0.
    expect(row?.failure_streak).toBe(2);
    // Positive control: a re-register DOES clear it, so the assertion above bites.
    repo.register({ token: EXPO_A, platform: "ios" });
    expect(repo.get(EXPO_A)?.failure_streak).toBe(0);
  });

  it("setPrefs only touches a token its device owns", () => {
    repo.register({ token: EXPO_A, platform: "ios", deviceId: "dev-a" });
    repo.register({ token: EXPO_B, platform: "ios", deviceId: "dev-b" });

    expect(repo.setPrefs(EXPO_B, ALWAYS_QUIET, "dev-a")).toBe(false);
    expect(repo.get(EXPO_B)?.notification_prefs).toBeNull();
    expect(repo.setPrefs(EXPO_A, ALWAYS_QUIET, "dev-a")).toBe(true);
    expect(repo.get(EXPO_A)?.notification_prefs).not.toBeNull();
  });

  it("setPrefs lets a device edit a token no device was recorded for, and the shared key any token", () => {
    repo.register({ token: EXPO_A, platform: "ios" });
    repo.register({ token: EXPO_B, platform: "ios", deviceId: "dev-b" });

    expect(repo.setPrefs(EXPO_A, ALWAYS_QUIET, "dev-x")).toBe(true);
    expect(repo.setPrefs(EXPO_B, ALWAYS_QUIET, null)).toBe(true);
  });
});

describe("ExpoPushSender applies preferences per token", () => {
  const msg = { title: "p", body: "b", data: {} };

  it("skips a token in quiet hours and still delivers to the others", async () => {
    repo.register({ token: EXPO_A, platform: "ios", notificationPrefs: ALWAYS_QUIET });
    repo.register({ token: EXPO_B, platform: "ios", notificationPrefs: ON });
    const calls = stubExpo();

    const outcome = await new ExpoPushSender(repo).send(msg, { event: "waitingInput" });

    expect(sentTo(calls)).toEqual([EXPO_B]);
    expect(outcome).toMatchObject({ attempted: 1, succeeded: 1, suppressed: 1 });
    // Suppressed is a choice, not a failure: the muted token stays healthy.
    expect(repo.get(EXPO_A)?.failure_streak).toBe(0);
  });

  it("gates each event on its own toggle", async () => {
    repo.register({
      token: EXPO_A,
      platform: "ios",
      notificationPrefs: { waitingInput: false, sessionFailed: true },
    });
    const calls = stubExpo();
    const sender = new ExpoPushSender(repo);

    expect((await sender.send(msg, { event: "waitingInput" })).suppressed).toBe(1);
    expect((await sender.send(msg, { event: "sessionFailed" })).succeeded).toBe(1);
    expect(sentTo(calls)).toEqual([EXPO_A]);
  });

  it("treats a token with no stored preferences as everything on", async () => {
    repo.register({ token: EXPO_A, platform: "ios" });
    const calls = stubExpo();
    const outcome = await new ExpoPushSender(repo).send(msg, { event: "waitingInput" });
    expect(outcome).toMatchObject({ attempted: 1, suppressed: 0 });
    expect(sentTo(calls)).toEqual([EXPO_A]);
  });

  it("fails open on a stored blob that no longer parses", async () => {
    repo.register({ token: EXPO_A, platform: "ios" });
    cache
      .getDatabase()
      .prepare("UPDATE push_tokens SET notification_prefs = ? WHERE token = ?")
      .run("{corrupt", EXPO_A);
    stubExpo();
    const outcome = await new ExpoPushSender(repo).send(msg, { event: "waitingInput" });
    expect(outcome.succeeded).toBe(1);
  });

  it("sendTo bypasses preferences", async () => {
    repo.register({ token: EXPO_A, platform: "ios", notificationPrefs: ALWAYS_QUIET });
    const row = repo.get(EXPO_A);
    if (!row) throw new Error("row missing");
    const calls = stubExpo();

    const outcome = await new ExpoPushSender(repo).sendTo([row], msg);

    expect(outcome).toMatchObject({ attempted: 1, succeeded: 1, suppressed: 0 });
    expect(sentTo(calls)).toEqual([EXPO_A]);
  });
});

describe("WaitingInputNotifier gates on preferences and reports failures", () => {
  const waitingBody = (calls: ReturnType<typeof stubExpo>) => calls.map((c) => c.body[0].body);

  async function turn(n: WaitingInputNotifier) {
    await n.onStatusChange(session({ status: "running" }), "waiting_input");
    await n.onStatusChange(
      session({ status: "waiting_input", statusSource: "turn-signal" }),
      "running",
    );
  }

  it("does not push a finished turn to a device that turned Waiting for Input off", async () => {
    repo.register({
      token: EXPO_A,
      platform: "ios",
      notificationPrefs: { waitingInput: false, sessionFailed: true },
    });
    repo.register({ token: EXPO_B, platform: "ios" });
    const calls = stubExpo();

    await turn(new WaitingInputNotifier(new ExpoPushSender(repo)));

    await vi.waitFor(() => expect(sentTo(calls)).toEqual([EXPO_B]), {
      timeout: TURN_DONE_SETTLE_MS + 1_000,
    });
  });

  it("gates permission and question prompts on the same toggle", async () => {
    repo.register({
      token: EXPO_A,
      platform: "ios",
      notificationPrefs: { waitingInput: false, sessionFailed: true },
    });
    const calls = stubExpo();
    const n = new WaitingInputNotifier(new ExpoPushSender(repo));

    await n.onPrompt(session(), "permission", true);
    await n.onPrompt(session({ id: "sess-2" }), "question", true);

    expect(calls).toHaveLength(0);
  });

  describe("session failed", () => {
    const failed = (over: Partial<ManagedSession> = {}) =>
      session({
        status: "idle",
        failureReason: "Project directory not found: /Users/someone/secret-project",
        failureCode: "project_dir_missing",
        ...over,
      });

    it("pushes once when a session dies before it ever prompted", async () => {
      repo.register({ token: EXPO_A, platform: "ios" });
      const calls = stubExpo();
      const n = new WaitingInputNotifier(new ExpoPushSender(repo));

      await n.onStatusChange(failed(), "running");
      await n.onStatusChange(failed(), "idle"); // a repeat emit

      expect(calls).toHaveLength(1);
      expect(waitingBody(calls)[0]).toBe("The project folder no longer exists on this computer.");
    });

    it("falls back to a generic next step for a failure it has no copy for", async () => {
      repo.register({ token: EXPO_A, platform: "ios" });
      const calls = stubExpo();

      await new WaitingInputNotifier(new ExpoPushSender(repo)).onStatusChange(
        failed({ failureCode: "something_new" }),
        "running",
      );

      expect(waitingBody(calls)[0]).toBe("Open the session for details.");
    });

    it("never puts the failure reason, or a path from it, in the push", async () => {
      repo.register({ token: EXPO_A, platform: "ios" });
      const calls = stubExpo();

      await new WaitingInputNotifier(new ExpoPushSender(repo)).onStatusChange(failed(), "running");

      const wire = JSON.stringify(calls);
      expect(calls).toHaveLength(1); // positive control: something was sent to search
      expect(wire).not.toContain("secret-project");
      expect(wire).not.toContain("/Users/");
    });

    it("respects a device that turned Session Failed off", async () => {
      repo.register({
        token: EXPO_A,
        platform: "ios",
        notificationPrefs: { waitingInput: true, sessionFailed: false },
      });
      repo.register({ token: EXPO_B, platform: "ios" });
      const calls = stubExpo();

      await new WaitingInputNotifier(new ExpoPushSender(repo)).onStatusChange(failed(), "running");

      expect(sentTo(calls)).toEqual([EXPO_B]);
    });

    it("stays quiet when a session that DID start keeps a failureReason and is closed later", async () => {
      // A Codex usage-limit screen sets failureReason on a live session. Closing
      // it much later goes idle with that reason still set — not a failed start.
      repo.register({ token: EXPO_A, platform: "ios" });
      const calls = stubExpo();
      const n = new WaitingInputNotifier(new ExpoPushSender(repo));

      await n.onStatusChange(session({ status: "waiting_input" }), undefined); // boot ready
      await n.onStatusChange(failed(), "waiting_input"); // closed afterwards

      expect(calls).toHaveLength(0);
    });

    it("counts a second failure after the session was alive again", async () => {
      repo.register({ token: EXPO_A, platform: "ios" });
      const calls = stubExpo();
      const n = new WaitingInputNotifier(new ExpoPushSender(repo));

      await n.onStatusChange(failed(), "running");
      await n.onStatusChange(session({ status: "running" }), "idle"); // resumed
      await n.onStatusChange(failed(), "running");

      expect(calls).toHaveLength(2);
    });
  });
});

describe("push preference routes", () => {
  let server: Server;
  let baseUrl: string;
  let principal: { kind: "device"; deviceId: string } | { kind: "api-key" } | undefined;

  beforeEach(async () => {
    principal = { kind: "api-key" };
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      // Stands in for the auth middleware, which is what sets the principal.
      c.set("principal", principal as any);
      await next();
    });
    const sender = new ExpoPushSender(repo);
    app.route(
      "/",
      createMiscRoutes({
        pushRepo: () => repo,
        expoPushSender: () => sender,
        expoPushEnabled: () => true,
        liveActivityPushEnabled: () => false,
      } as never),
    );
    baseUrl = await new Promise<string>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve(`http://127.0.0.1:${info.port}`),
      ) as Server;
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const send = (method: string, path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  describe("POST /api/push/register with notificationPrefs", () => {
    it("stores valid preferences", async () => {
      const res = await send("POST", "/api/push/register", {
        token: EXPO_A,
        platform: "ios",
        notificationPrefs: ALWAYS_QUIET,
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(repo.get(EXPO_A)?.notification_prefs ?? "null")).toEqual(ALWAYS_QUIET);
    });

    it("rejects an unknown time zone and stores nothing", async () => {
      const res = await send("POST", "/api/push/register", {
        token: EXPO_A,
        platform: "ios",
        notificationPrefs: {
          ...ON,
          quietHours: { ...ALWAYS_QUIET.quietHours, tz: "Mars/Olympus" },
        },
      });
      expect(res.status).toBe(400);
      expect(repo.get(EXPO_A)).toBeNull();
    });

    it("still accepts a client that sends none", async () => {
      const res = await send("POST", "/api/push/register", { token: EXPO_A, platform: "ios" });
      expect(res.status).toBe(200);
      expect(repo.get(EXPO_A)?.notification_prefs).toBeNull();
    });
  });

  describe("POST /api/push/register with notificationFeatures", () => {
    it("stores a valid list", async () => {
      const res = await send("POST", "/api/push/register", {
        token: EXPO_A,
        platform: "android",
        notificationFeatures: ["attention-v1"],
      });
      expect(res.status).toBe(200);
      expect(repo.get(EXPO_A)?.notification_features).toBe('["attention-v1"]');
    });

    it.each([
      ["a string", "attention-v1"],
      ["a non-string entry", [1]],
      ["a name outside the charset", ["Attention V1"]],
      ["too many names", Array(17).fill("x")],
    ])("rejects %s and stores nothing", async (_, notificationFeatures) => {
      const res = await send("POST", "/api/push/register", {
        token: EXPO_A,
        platform: "android",
        notificationFeatures,
      });
      expect(res.status).toBe(400);
      expect(repo.get(EXPO_A)).toBeNull();
    });
  });

  describe("PATCH /api/push/preferences", () => {
    it("updates a registered token", async () => {
      repo.register({ token: EXPO_A, platform: "ios" });
      const res = await send("PATCH", "/api/push/preferences", {
        token: EXPO_A,
        prefs: ALWAYS_QUIET,
      });
      expect(res.status).toBe(204);
      expect(JSON.parse(repo.get(EXPO_A)?.notification_prefs ?? "null")).toEqual(ALWAYS_QUIET);
    });

    it("tells a client its token is not registered, rather than pretending it saved", async () => {
      const res = await send("PATCH", "/api/push/preferences", { token: "nope", prefs: ON });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("TOKEN_NOT_FOUND");
    });

    it("rejects malformed preferences and a missing token", async () => {
      repo.register({ token: EXPO_A, platform: "ios" });
      expect(
        (
          await send("PATCH", "/api/push/preferences", {
            token: EXPO_A,
            prefs: { waitingInput: 1 },
          })
        ).status,
      ).toBe(400);
      expect((await send("PATCH", "/api/push/preferences", { prefs: ON })).status).toBe(400);
      expect(repo.get(EXPO_A)?.notification_prefs).toBeNull();
    });

    it("lets a device change its own token but answers 404 for another device's", async () => {
      repo.register({ token: EXPO_A, platform: "ios", deviceId: "dev-a" });
      repo.register({ token: EXPO_B, platform: "ios", deviceId: "dev-b" });
      principal = { kind: "device", deviceId: "dev-a" };

      expect(
        (await send("PATCH", "/api/push/preferences", { token: EXPO_A, prefs: ALWAYS_QUIET }))
          .status,
      ).toBe(204);
      expect(
        (await send("PATCH", "/api/push/preferences", { token: EXPO_B, prefs: ALWAYS_QUIET }))
          .status,
      ).toBe(404);
      expect(repo.get(EXPO_B)?.notification_prefs).toBeNull();
    });
  });

  describe("POST /api/push/test", () => {
    it("sends a real push through Expo and reports the outcome", async () => {
      repo.register({ token: EXPO_A, platform: "ios", locale: "he" });
      const calls = stubExpo();

      const res = await send("POST", "/api/push/test", { token: EXPO_A });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(sentTo(calls)).toEqual([EXPO_A]);
      expect(body).toMatchObject({ ok: true, attempted: 1, succeeded: 1, state: "healthy" });
      // Localised like every other push.
      expect(calls[0].body[0].body).toContain("בדיקה");
    });

    it("is not muted by the user's own quiet hours", async () => {
      repo.register({ token: EXPO_A, platform: "ios", notificationPrefs: ALWAYS_QUIET });
      const calls = stubExpo();
      const body = await (await send("POST", "/api/push/test", { token: EXPO_A })).json();
      expect(body.ok).toBe(true);
      expect(sentTo(calls)).toEqual([EXPO_A]);
    });

    it("reports a relay failure instead of claiming success", async () => {
      repo.register({ token: EXPO_A, platform: "ios" });
      stubExpo([{ status: 500 }]);
      const body = await (await send("POST", "/api/push/test", { token: EXPO_A })).json();
      expect(body).toMatchObject({ ok: false, succeeded: 0, state: "failing" });
    });

    it("refuses another device's token, an unknown token and a Live Activity token", async () => {
      repo.register({ token: EXPO_B, platform: "ios", deviceId: "dev-b" });
      repo.register({ token: "la-start", platform: "ios", kind: "liveactivity_start" });
      const calls = stubExpo();
      principal = { kind: "device", deviceId: "dev-a" };

      expect((await send("POST", "/api/push/test", { token: EXPO_B })).status).toBe(404);
      expect((await send("POST", "/api/push/test", { token: "nope" })).status).toBe(404);
      principal = { kind: "api-key" };
      expect((await send("POST", "/api/push/test", { token: "la-start" })).status).toBe(400);
      expect(calls).toHaveLength(0);
      // Positive control: the same caller is served once the token is theirs.
      principal = { kind: "device", deviceId: "dev-b" };
      expect((await send("POST", "/api/push/test", { token: EXPO_B })).status).toBe(200);
    });
  });
});
