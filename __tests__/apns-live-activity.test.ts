import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository } from "../src/db/repositories/push.repository";
import {
  APNS_HOST_SANDBOX,
  APNS_MAX_PAYLOAD_BYTES,
  type ApnsSendResult,
  describeMissingApnsCredentials,
  readApnsCredentialsFromEnv,
} from "../src/services/push/apnsClient";
import {
  LAST_OUTPUT_MAX_LENGTH,
  toLiveActivityStatus,
  truncateLastOutput,
} from "../src/services/push/liveActivityContentState";
import { contentStateForSession } from "../src/services/push/liveActivityNotifier";
import {
  buildActivityKitPayload,
  LiveActivitySender,
} from "../src/services/push/liveActivitySender";
import type { ManagedSession } from "../src/types";

/**
 * Direct APNs Live Activity sender (Feature 12 phase 1b).
 *
 * ActivityKit cannot go through Expo's relay, so this path is a direct HTTP/2
 * POST to APNs with an ES256 provider JWT. The tests that matter here are the
 * ones covering silent failures: a content-state field drifting from mobile's
 * Codable struct, and a dead token being retried forever.
 */

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-apns-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A throwaway EC P-256 key, generated per run. Never a real credential. */
function testKeyPem(): string {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey as unknown as string;
}

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    projectPath: "/tmp/proj",
    projectName: "proj",
    branch: "main",
    status: "running",
    startedAt: new Date(1_700_000_000_000),
    completedAt: null,
    promptCount: 0,
    lastOutput: "building",
    ...overrides,
  } as ManagedSession;
}

/**
 * Content state for a plain running session.
 *
 * contentStateForSession returns null for a non-renderable status; these tests
 * always pass a running session, so this narrows without a non-null assertion.
 */
function runningState(overrides: Partial<ManagedSession> = {}) {
  const state = contentStateForSession({ session: session(overrides), serverId: "srv" });
  if (!state) throw new Error("expected a renderable content state");
  return state;
}

/** Read the aps envelope off a captured payload, failing loudly if absent. */
function apsOf(payload: unknown): { event: string; "content-state": { status: string } } {
  const aps = (payload as { aps?: { event: string; "content-state": { status: string } } })?.aps;
  if (!aps) throw new Error("expected an aps envelope on the sent payload");
  return aps;
}

describe("credentials", () => {
  /** A fully configured environment. No real account identifiers appear here. */
  const FULL_ENV = {
    APNS_KEY: "-----BEGIN PRIVATE KEY-----\nx\n",
    APNS_KEY_ID: "FAKEKEY123",
    APNS_TEAM_ID: "FAKETEAM99",
    APNS_BUNDLE_ID: "com.example.testapp",
  };

  it("reads the key from the environment, not a path", () => {
    const creds = readApnsCredentialsFromEnv(FULL_ENV);

    expect(creds?.key).toContain("BEGIN PRIVATE KEY");
    // Sandbox by default: the app's aps-environment is still development.
    expect(creds?.host).toBe(APNS_HOST_SANDBOX);
    expect(creds?.bundleId).toBe("com.example.testapp");
  });

  // A missing optional push credential must never stop the server booting.
  it("returns null when APNS_KEY is absent", () => {
    expect(readApnsCredentialsFromEnv({})).toBeNull();
    expect(readApnsCredentialsFromEnv({ APNS_KEY: "   " })).toBeNull();
  });

  // No account identifier is defaulted in the source: baking one deployment's
  // Apple account in would make this silently sign for the wrong team elsewhere.
  it.each([
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_BUNDLE_ID",
  ] as const)("returns null when %s is missing rather than guessing an account", (missing) => {
    const env: NodeJS.ProcessEnv = { ...FULL_ENV };
    delete env[missing];

    expect(readApnsCredentialsFromEnv(env)).toBeNull();
  });

  it("explains the absence of the key without revealing anything", () => {
    const why = describeMissingApnsCredentials({});
    expect(why).toContain("APNS_KEY");
    expect(describeMissingApnsCredentials(FULL_ENV)).toBeNull();
  });

  // The harder case to diagnose: it looks configured, and APNs answers a
  // mismatch with a bare InvalidProviderToken that names nothing.
  it("names which identifier is missing when the key is present", () => {
    const why = describeMissingApnsCredentials({
      APNS_KEY: "k",
      APNS_KEY_ID: "FAKEKEY123",
    });

    // Assert on the "is set but X are not" list rather than the whole string:
    // the trailing guidance sentence legitimately mentions APNS_KEY_ID.
    const listed = why?.match(/APNS_KEY is set but (.+?) are not/)?.[1];
    expect(listed).toBe("APNS_TEAM_ID, APNS_BUNDLE_ID");
  });

  it("allows overriding the host for production", () => {
    const creds = readApnsCredentialsFromEnv({
      ...FULL_ENV,
      APNS_HOST: "api.push.apple.com",
    });
    expect(creds?.host).toBe("api.push.apple.com");
  });
});

describe("provider JWT", () => {
  // Node signs ECDSA as DER by default; JWS requires raw r||s. APNs rejects the
  // DER form as InvalidProviderToken, an error that does not hint at encoding.
  it("signs ES256 in the raw r||s form JWS requires", async () => {
    const { ApnsClient } = await import("../src/services/push/apnsClient");
    const client = new ApnsClient({
      key: testKeyPem(),
      keyId: "TESTKEYID",
      teamId: "TESTTEAM",
      bundleId: "com.example.app",
      host: APNS_HOST_SANDBOX,
    });

    // getJwt is private; exercised through the same path send() uses.
    const jwt = (client as unknown as { getJwt: (now?: number) => string }).getJwt();
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "TESTKEYID",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).iss).toBe("TESTTEAM");
    // P-256 raw signature is exactly 64 bytes; DER would be ~70 and variable.
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
  });

  it("reuses the JWT rather than minting one per send", async () => {
    const { ApnsClient } = await import("../src/services/push/apnsClient");
    const client = new ApnsClient({
      key: testKeyPem(),
      keyId: "K",
      teamId: "T",
      bundleId: "com.example.app",
      host: APNS_HOST_SANDBOX,
    });
    const getJwt = (client as unknown as { getJwt: (now?: number) => string }).getJwt.bind(client);

    expect(getJwt(1_000_000)).toBe(getJwt(1_000_000 + 60_000));
    // Past the cached lifetime it must mint a fresh one — Apple rejects a token
    // older than an hour.
    expect(getJwt(1_000_000)).not.toBe(getJwt(1_000_000 + 4_000_000));
  });

  it("builds the mandatory liveactivity topic", async () => {
    const { ApnsClient } = await import("../src/services/push/apnsClient");
    const client = new ApnsClient({
      key: testKeyPem(),
      keyId: "K",
      teamId: "T",
      bundleId: "com.example.testapp",
      host: APNS_HOST_SANDBOX,
    });

    expect(client.topic).toBe("com.example.testapp.push-type.liveactivity");
  });
});

describe("content-state contract", () => {
  // A field name drifting from mobile's Codable struct breaks the surface
  // silently: ActivityKit just stops updating, with no server-side error.
  it("sends exactly the fields mobile decodes", () => {
    const state = contentStateForSession({
      session: session(),
      serverId: "srv-1",
      serverLabel: "macbook",
    });

    expect(Object.keys(state ?? {}).sort()).toEqual([
      "lastOutput",
      "projectName",
      "serverId",
      "serverLabel",
      "sessionId",
      "startedAt",
      "status",
    ]);
  });

  // iOS renders its own ticking timer from startedAt, so this must be the raw
  // epoch-ms start and never a computed elapsed value.
  it("passes startedAt through as epoch milliseconds", () => {
    const state = contentStateForSession({ session: session(), serverId: "srv-1" });

    expect(state?.startedAt).toBe(1_700_000_000_000);
  });

  it("omits the optional serverLabel when absent", () => {
    const state = contentStateForSession({ session: session(), serverId: "srv-1" });

    expect("serverLabel" in (state ?? {})).toBe(false);
  });

  it("only renders running and waiting_input", () => {
    expect(toLiveActivityStatus("running")).toBe("running");
    expect(toLiveActivityStatus("waiting_input")).toBe("waiting_input");
    // idle has no surface representation — that case is an end, not an update.
    expect(toLiveActivityStatus("idle")).toBeNull();
    expect(
      contentStateForSession({ session: session({ status: "idle" }), serverId: "s" }),
    ).toBeNull();
  });

  it("truncates lastOutput to the shared bound", () => {
    const long = "x".repeat(200);
    expect(truncateLastOutput(long)).toHaveLength(LAST_OUTPUT_MAX_LENGTH);
    // Collapsed to one line: the surface renders a single line.
    expect(truncateLastOutput("a\n\nb   c")).toBe("a b c");
  });

  it("keeps a worst-case payload under the APNs limit", () => {
    const payload = buildActivityKitPayload({
      event: "update",
      contentState: {
        sessionId: "s".repeat(64),
        serverId: "v".repeat(64),
        projectName: "p".repeat(255),
        status: "running",
        startedAt: 1_700_000_000_000,
        lastOutput: truncateLastOutput("x".repeat(500)),
        serverLabel: "l".repeat(255),
      },
      now: 1_700_000_100_000,
    });

    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(APNS_MAX_PAYLOAD_BYTES);
  });
});

describe("aps envelope", () => {
  // Apple's key names, hyphenated where Apple hyphenates them.
  it("uses Apple's aps key names and second-precision timestamps", () => {
    const payload = buildActivityKitPayload({
      event: "update",
      contentState: {
        sessionId: "s1",
        serverId: "v1",
        projectName: "p",
        status: "running",
        startedAt: 1_700_000_000_000,
        lastOutput: "out",
      },
      now: 1_700_000_123_456,
      staleDate: 1_700_030_000_000,
    });

    expect(Object.keys(payload.aps).sort()).toEqual([
      "content-state",
      "event",
      "stale-date",
      "timestamp",
    ]);
    // Seconds, not milliseconds — iOS discards a push it reads as regressing.
    expect(payload.aps.timestamp).toBe(1_700_000_123);
    expect(payload.aps["stale-date"]).toBe(1_700_030_000);
  });
});

/** An ApnsClient stand-in: no network, scripted results. */
function fakeApns(results: ApnsSendResult[] | ((token: string) => ApnsSendResult)) {
  const sent: Array<{ deviceToken: string; payload: unknown }> = [];
  let i = 0;
  return {
    sent,
    client: {
      send: vi.fn(async (args: { deviceToken: string; payload: unknown }) => {
        sent.push(args);
        return typeof results === "function" ? results(args.deviceToken) : results[i++];
      }),
      topic: "com.example.app.push-type.liveactivity",
      close: vi.fn(),
    },
  };
}

const okResult: ApnsSendResult = { ok: true, status: 200, tokenDead: false };

describe("send outcomes", () => {
  function registerActivity(token: string, sessionId = "sess-1") {
    repo.register({
      token,
      platform: "ios",
      kind: "liveactivity_update",
      activityId: `act-${token}`,
      sessionId,
      startedAt: 1_700_000_000_000,
    });
  }

  it("sends to every activity of the session and records success", async () => {
    registerActivity("tok-a");
    registerActivity("tok-b");
    const { client } = fakeApns([okResult, okResult]);
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );

    const outcome = await sender.send({
      sessionId: "sess-1",
      event: "update",
      contentState: runningState(),
    });

    expect(outcome).toEqual({ attempted: 2, succeeded: 2, retired: 0 });
    expect(repo.get("tok-a")?.last_success_at).not.toBeNull();
  });

  // The headline requirement: a dead token is retired, not retried forever.
  it("retires a token APNs rejects as permanently invalid", async () => {
    registerActivity("dead-tok");
    const { client } = fakeApns([
      { ok: false, status: 410, reason: "Unregistered", tokenDead: true },
    ]);
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );

    const outcome = await sender.send({
      sessionId: "sess-1",
      event: "update",
      contentState: runningState(),
    });

    expect(outcome.retired).toBe(1);
    // Expired locally, so it is no longer a delivery target.
    expect(repo.listForSession("liveactivity_update", "sess-1")).toEqual([]);
  });

  // A transient failure must NOT retire the token — the device is still there.
  it("keeps a token after a transient failure", async () => {
    registerActivity("flaky-tok");
    const { client } = fakeApns([
      { ok: false, status: 503, reason: "ServiceUnavailable", tokenDead: false },
    ]);
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );

    const outcome = await sender.send({
      sessionId: "sess-1",
      event: "update",
      contentState: runningState(),
    });

    expect(outcome.retired).toBe(0);
    expect(repo.get("flaky-tok")?.failure_streak).toBe(1);
    expect(repo.listForSession("liveactivity_update", "sess-1")).toHaveLength(1);
  });

  // One dead device must not silence every other device on the same session.
  it("keeps sending to healthy tokens when one is rejected", async () => {
    registerActivity("dead-tok");
    registerActivity("live-tok");
    const { client } = fakeApns((token) =>
      token === "dead-tok"
        ? { ok: false, status: 410, reason: "BadDeviceToken", tokenDead: true }
        : okResult,
    );
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );

    const outcome = await sender.send({
      sessionId: "sess-1",
      event: "update",
      contentState: runningState(),
    });

    expect(outcome).toEqual({ attempted: 2, succeeded: 1, retired: 1 });
  });

  it("does not touch tokens belonging to another session", async () => {
    registerActivity("mine", "sess-1");
    registerActivity("theirs", "sess-2");
    const { client, sent } = fakeApns([okResult]);
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );

    await sender.send({
      sessionId: "sess-1",
      event: "update",
      contentState: runningState(),
    });

    expect(sent.map((s) => s.deviceToken)).toEqual(["mine"]);
  });

  // Without expiring locally, a renewal sweep would later resurrect an activity
  // for a session that has already finished.
  it("expires every activity after an end event", async () => {
    registerActivity("tok-a");
    const { client, sent } = fakeApns([okResult]);
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );

    await sender.end({
      sessionId: "sess-1",
      contentState: runningState(),
    });

    expect(apsOf(sent[0]?.payload).event).toBe("end");
    expect(repo.listForSession("liveactivity_update", "sess-1")).toEqual([]);
    expect(repo.listRenewable()).toEqual([]);
  });

  // A throw inside the client is a real failure, but must not take the server
  // down or vanish.
  it("records a thrown send error without propagating it", async () => {
    registerActivity("boom-tok");
    const client = {
      send: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
      topic: "t",
      close: vi.fn(),
    };
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );

    const outcome = await sender.send({
      sessionId: "sess-1",
      event: "update",
      contentState: runningState(),
    });

    expect(outcome.succeeded).toBe(0);
    expect(repo.get("boom-tok")?.last_failure_code).toBe("SendError");
  });

  it("is a no-op when the session has no live activity", async () => {
    const { client } = fakeApns([]);
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );

    const outcome = await sender.send({
      sessionId: "no-activity",
      event: "update",
      contentState: runningState(),
    });

    expect(outcome).toEqual({ attempted: 0, succeeded: 0, retired: 0 });
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("notifier", () => {
  it("pushes on a status change and skips an unchanged status", async () => {
    repo.register({
      token: "tok-a",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-a",
      sessionId: "sess-1",
      startedAt: 1_700_000_000_000,
    });
    const { client } = fakeApns(() => okResult);
    const { LiveActivityNotifier } = await import("../src/services/push/liveActivityNotifier");
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );
    const notifier = new LiveActivityNotifier(sender, "srv-1");

    await notifier.onStatusChange(session({ status: "running" }));
    // Live Activity pushes are rate-limited by iOS, so an unchanged status is
    // budget spent for no visible change.
    await notifier.onStatusChange(session({ status: "running" }));
    await notifier.onStatusChange(session({ status: "waiting_input" }));

    const events = client.send.mock.calls.map(
      (c) => (c[0].payload as { aps: { event: string; "content-state": { status: string } } }).aps,
    );
    expect(events.map((e) => e["content-state"].status)).toEqual(["running", "waiting_input"]);
  });

  it("ends the activity when the session goes idle", async () => {
    repo.register({
      token: "tok-a",
      platform: "ios",
      kind: "liveactivity_update",
      activityId: "act-a",
      sessionId: "sess-1",
      startedAt: 1_700_000_000_000,
    });
    const { client } = fakeApns(() => okResult);
    const { LiveActivityNotifier } = await import("../src/services/push/liveActivityNotifier");
    const sender = new LiveActivitySender(
      client as unknown as import("../src/services/push/apnsClient").ApnsClient,
      repo,
    );
    const notifier = new LiveActivityNotifier(sender, "srv-1");

    await notifier.onStatusChange(session({ status: "running" }));
    await notifier.onStatusChange(session({ status: "idle", completedAt: new Date() }));

    const lastCall = client.send.mock.calls.at(-1);
    expect(apsOf(lastCall?.[0].payload).event).toBe("end");
    expect(repo.listForSession("liveactivity_update", "sess-1")).toEqual([]);
  });
});
