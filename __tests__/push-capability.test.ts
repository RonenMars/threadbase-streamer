import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describePushCapability } from "../src/api/routes/misc.routes";
import { StreamerServer } from "../src/server";

/**
 * Push capability surface (#519).
 *
 * The server knew at boot whether Live Activity push could work — it logged it —
 * and told no client. `/api/push/health`'s `available` reported that the SQLite
 * store had opened, so it was `true` on a server that can never send a push, and
 * mobile offered a feature that silently no-ops.
 */

const FULL_APNS_ENV = {
  APNS_KEY: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
  APNS_KEY_ID: "TESTKEYID1",
  APNS_TEAM_ID: "TESTTEAM01",
  APNS_BUNDLE_ID: "com.example.threadbase",
} as const;

const API_KEY = "tb_test_key_for_push_capability";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

// Same host isolation server.test.ts uses: keep the scanner off the developer's
// real ~/.codex and off the shared persistent index.
const HOST_ISOLATION = { codexRoots: [] as string[], scannerPersistent: false };

describe("describePushCapability", () => {
  it("reports both push kinds, not just Live Activities", () => {
    // The pairing matters: ordinary push has no server-side implementation
    // either, so a client must not read a configured APNs key as "notifications
    // work". Both fields are always present.
    const on = describePushCapability(true, FULL_APNS_ENV);
    expect(on).toEqual({ liveActivity: true, notifications: false });

    const off = describePushCapability(false, {});
    expect(off.liveActivity).toBe(false);
    expect(off.notifications).toBe(false);
  });

  it("names the missing variable when credentials are absent", () => {
    expect(describePushCapability(false, {}).liveActivityReason).toContain("APNS_KEY");
    expect(describePushCapability(false, { APNS_KEY: "k" }).liveActivityReason).toContain(
      "APNS_KEY_ID",
    );
  });

  // Reachable: the notifier is only wired when the push token store opened, so
  // complete credentials are not sufficient. Without this branch the reason
  // would be undefined on a disabled feature — exactly the silence #519 is about.
  it("still explains itself when the credentials are complete but push is off", () => {
    const off = describePushCapability(false, FULL_APNS_ENV);
    expect(off.liveActivity).toBe(false);
    expect(off.liveActivityReason).toContain("token store is unavailable");
  });

  // The string is served over the API, not just logged. It may name a variable;
  // it must never carry one's value.
  it("never leaks credential material into the reason", () => {
    const reason = describePushCapability(false, {
      APNS_KEY: "SUPER-SECRET-PEM",
    }).liveActivityReason;
    expect(reason).not.toContain("SUPER-SECRET-PEM");
  });
});

describe("push capability over HTTP", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let cacheDir: string;

  const boot = async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "threadbase-push-cap-"));
    server = new StreamerServer({
      ...HOST_ISOLATION,
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
    });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  };

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe("without APNs credentials", () => {
    const saved = { ...process.env };
    beforeEach(async () => {
      for (const key of Object.keys(FULL_APNS_ENV)) delete process.env[key];
      await boot();
    });
    afterEach(() => {
      process.env = { ...saved };
    });

    it("reports Live Activity push as unavailable on /api/info", async () => {
      const body = await (await fetch(`${baseUrl}/api/info`, { headers: AUTH })).json();
      expect(body.push.liveActivity).toBe(false);
      expect(body.push.notifications).toBe(false);
      expect(body.push.liveActivityReason).toContain("APNS_KEY");
    });

    // The bug verbatim: the store opened, so `available` was true on a server
    // that can never deliver. `available` keeps that meaning; `push` tells the
    // truth beside it.
    it("keeps available meaning 'store opened' and reports capability separately", async () => {
      const body = await (await fetch(`${baseUrl}/api/push/health`, { headers: AUTH })).json();
      expect(body.available).toBe(true);
      expect(body.push.liveActivity).toBe(false);
      expect(Array.isArray(body.tokens)).toBe(true);
    });
  });

  describe("with APNs credentials", () => {
    const saved = { ...process.env };
    beforeEach(async () => {
      Object.assign(process.env, FULL_APNS_ENV);
      await boot();
    });
    afterEach(() => {
      process.env = { ...saved };
    });

    it("reports Live Activity push as available, with no reason to give", async () => {
      const body = await (await fetch(`${baseUrl}/api/info`, { headers: AUTH })).json();
      expect(body.push).toEqual({ liveActivity: true, notifications: false });
    });

    it("agrees with /api/push/health", async () => {
      const body = await (await fetch(`${baseUrl}/api/push/health`, { headers: AUTH })).json();
      expect(body.push.liveActivity).toBe(true);
      expect(body.available).toBe(true);
    });
  });
});
