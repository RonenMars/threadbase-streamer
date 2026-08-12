import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findFeatureFlag } from "../src/feature-flags";
import { StreamerServer } from "../src/server";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any) =>
    h.calls.push({ level, msg, fields });
  const fake = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    log: () => {},
    pino: { isLevelEnabled: () => false },
  };
  return { getLogger: () => fake, logger: fake };
});

const eventsOf = (event: string) => h.calls.filter((c) => c.fields?.event === event);

// Complete, syntactically plausible, and entirely fake. ApnsClient's constructor
// is inert — it neither parses the PEM nor opens a session until the first send
// — so a bogus key is enough to make readApnsCredentialsFromEnv() succeed and
// drive initLiveActivityPush past the credential check to the flag check.
const FAKE_APNS = {
  APNS_KEY: "-----BEGIN PRIVATE KEY-----\nnotarealkey\n-----END PRIVATE KEY-----\n",
  APNS_KEY_ID: "FAKEKEY123",
  APNS_TEAM_ID: "FAKETEAM99",
  APNS_BUNDLE_ID: "com.example.threadbase",
};

let server: StreamerServer | null = null;
let cacheDir: string;
const savedEnv: Record<string, string | undefined> = {};

async function bootWithFlag(liveActivityPush: boolean): Promise<void> {
  server = new StreamerServer({
    codexRoots: [],
    scannerPersistent: false,
    port: 0,
    apiKey: "tb_test_key_for_live_activity_flag",
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir,
    // The CLI rung. beforeEach clears the env var so it cannot outrank this.
    featureFlags: { liveActivityPush },
  });
  await server.listen(0, { awaitReady: true });
}

beforeEach(() => {
  h.calls.length = 0;
  cacheDir = mkdtempSync(join(tmpdir(), "threadbase-la-flag-"));
  for (const [k, v] of Object.entries(FAKE_APNS)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  // Env outranks the CLI rung, so a real THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH
  // in the developer's shell would otherwise silently decide both cases.
  savedEnv.THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH =
    process.env.THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH;
  delete process.env.THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH;
});

afterEach(async () => {
  await server?.close();
  server = null;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("liveActivityPush feature flag", () => {
  it("keeps its env var name stable, and its default OFF", () => {
    const flag = findFeatureFlag("liveActivityPush");
    expect(flag?.env).toBe("THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH");
    expect(flag?.default).toBe(false);
  });

  // The positive control. Without it, the assertion below passes just as
  // happily against a boot that failed for some unrelated reason — a bad
  // cacheDir, a changed credential shape — and the flag would look load-bearing
  // when nothing is reading it at all.
  it("brings Live Activity push up when the flag is on and credentials are present", async () => {
    await bootWithFlag(true);
    expect(eventsOf("live_activity.enabled")).toHaveLength(1);
    expect(eventsOf("live_activity.disabled")).toHaveLength(0);
  });

  it("leaves it down when the flag is off, despite the same credentials", async () => {
    await bootWithFlag(false);
    expect(eventsOf("live_activity.enabled")).toHaveLength(0);

    const disabled = eventsOf("live_activity.disabled");
    expect(disabled).toHaveLength(1);
    // Distinguishes "the flag turned it off" from "the credentials went
    // missing" — both log the same event, and confusing them costs an operator
    // an hour checking a p8 that was fine.
    expect(disabled[0].msg).toContain("liveActivityPush");
  });
});
