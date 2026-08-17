import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describeE2eeCapability, E2EE_PROTOCOL_VERSION } from "../src/api/routes/misc.routes";
import { FEATURE_FLAGS, resolveFeatureFlags } from "../src/feature-flags";
import { StreamerServer } from "../src/server";

/**
 * E2EE capability negotiation (#590, GATE 2).
 *
 * This lands BEFORE the handshake it gates, and that ordering is the point. The
 * QR format and the pairing exchange both move in Phase 2, across two repos that
 * cannot merge atomically — so without a negotiated capability there is a window
 * where one repo's `main` is ahead of the other and pairing is broken. With it,
 * a half-landed state is inert: a client only attempts a handshake against a
 * server that says it has one.
 *
 * These tests therefore assert the *inertness*, not that a field exists.
 */

const API_KEY = "tb_test_key_for_e2ee_capability";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

// Same host isolation the other HTTP tests use: keep the scanner off the
// developer's real ~/.codex and off the shared persistent index.
const HOST_ISOLATION = { codexRoots: [] as string[], scannerPersistent: false };

describe("describeE2eeCapability", () => {
  it("reports the version and never claims to require encryption", () => {
    // `required` is the stage-3 bit and is an explicit product decision with a
    // minimum app version behind it, never a default. Reported rather than
    // omitted because absent means "unknown" on this endpoint, and this server
    // knows the answer.
    for (const flag of [true, false]) {
      const cap = describeE2eeCapability(flag);
      expect(cap.version).toBe(E2EE_PROTOCOL_VERSION);
      expect(cap.required).toBe(false);
    }
  });

  /**
   * The GATE 2 guarantee, stated as a property.
   *
   * `supported` means "this build speaks the envelope". Until the handshake
   * lands it does not, so switching the feature flag on must NOT produce
   * `enabled: true` — a client that believed it would offer to re-pair for
   * encryption against a server with no handshake endpoint, which is the exact
   * half-landed break the negotiation exists to remove.
   */
  it("stays disabled even with the feature flag on, while the handshake is unbuilt", () => {
    const cap = describeE2eeCapability(true);
    expect(cap.supported).toBe(false);
    expect(cap.enabled).toBe(false);
  });

  it("says why it is disabled instead of going silent", () => {
    // Stated as the property rather than as today's wording: an operator who
    // set the flag and saw nothing change has one question, and a reason that
    // goes absent in precisely the case they hit is the field not answering it.
    // Phase 2 changes which cause is reported; it must not change that one is.
    for (const flag of [true, false]) {
      const cap = describeE2eeCapability(flag);
      if (cap.enabled) continue;
      expect(typeof cap.reason).toBe("string");
      expect(cap.reason?.length).toBeGreaterThan(0);
    }
  });
});

describe("the e2ee feature flag", () => {
  it("is registered, off by default, and carries an env override", () => {
    const def = FEATURE_FLAGS.e2ee;
    // Off by default is GATE 3: tb-mobile is released and cannot be
    // force-updated, so encryption is negotiated per device and never forced.
    expect(def.default).toBe(false);
    expect(def.env).toBe("THREADBASE_FEATURE_E2EE");
  });

  it("resolves off with no configuration at all", () => {
    expect(resolveFeatureFlags({ env: {} }).values.e2ee).toBe(false);
  });
});

describe("e2ee capability over HTTP", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let cacheDir: string;

  const boot = async (e2ee: boolean) => {
    // The env var outranks the config rung (feature-flags.ts), so a real
    // THREADBASE_FEATURE_E2EE in the developer's shell would otherwise decide
    // both cases and make this pass or fail off machine state.
    delete process.env.THREADBASE_FEATURE_E2EE;
    cacheDir = mkdtempSync(join(tmpdir(), "threadbase-e2ee-cap-"));
    server = new StreamerServer({
      ...HOST_ISOLATION,
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      featureFlags: { e2ee },
    });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  };

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("serves the capability object on /api/info with the flag off", async () => {
    await boot(false);
    const body = await (await fetch(`${baseUrl}/api/info`, { headers: AUTH })).json();
    expect(body.e2ee).toMatchObject({
      supported: false,
      enabled: false,
      version: E2EE_PROTOCOL_VERSION,
      required: false,
    });
    expect(typeof body.e2ee.reason).toBe("string");
  });

  // The inertness guarantee end to end: an operator can switch the flag on and
  // a client still sees `enabled: false`, because this build has no handshake to
  // offer. Nothing about turning the flag on is reachable by a client.
  it("still reports enabled:false over HTTP with the flag switched on", async () => {
    await boot(true);
    const body = await (await fetch(`${baseUrl}/api/info`, { headers: AUTH })).json();
    expect(body.e2ee.enabled).toBe(false);
    expect(body.e2ee.supported).toBe(false);
  });

  // Additive, in the sense that actually matters: the fields a released mobile
  // build reads are untouched beside the new object. Nothing here is renamed,
  // removed, or retyped.
  it("leaves the rest of /api/info unchanged", async () => {
    await boot(false);
    const body = await (await fetch(`${baseUrl}/api/info`, { headers: AUTH })).json();
    expect(body.claudeFlags).toBe(true);
    expect(body.featureFlags).toBe(true);
    expect(body.devicesDurable).toBe(true);
    expect(body.push).toBeDefined();
    expect(typeof body.version).toBe("string");
  });
});
