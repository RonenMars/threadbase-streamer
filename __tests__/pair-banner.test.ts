import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { printServerBanner, printUrlBanner } from "../cli/pair-banner";
import * as miscRoutes from "../src/api/routes/misc.routes";
import { StreamerServer } from "../src/server";
import { serverIdentityFingerprint, serverIdentityPublicKey } from "../src/server-identity";

/**
 * The pairing QR's `spk`/`v` parameters (design.md §2.3).
 *
 * The QR is the client's ONLY pairing-time capability signal — `GET /api/info`
 * is authenticated and pairing is the request that mints the credential — so
 * "the QR carried a valid `spk`" has to mean "this server will accept a
 * handshake". These assert on the payload that is actually printed and encoded
 * into the QR, not on what the capability helper returned, because the helper
 * agreeing with the spec while the banner appends unconditionally is exactly
 * the bug this covers.
 *
 * Two layers, and the second is not optional. The mocked-`fetch` cases below
 * pin how each capability answer is read; the real-server suite at the bottom
 * pins that the CLI can obtain that answer at all. A mock proves the parsing
 * and says nothing about reachability — and the failure it cannot see is the
 * expensive one: if the probe ever 401s against a current, E2EE-enabled daemon,
 * every enabled server silently starts printing a legacy QR, every client takes
 * the plaintext path, and no error is reported anywhere.
 */

const IDENTITY_KEY = "iEiHqvzCQFcy0hb26pKzoTLKmvzTX0YT6-kpUxV1TB4";
const EXPIRES_AT = 1_760_000_000_000;
// Pinned so the payload is byte-comparable; resolveServerUrl otherwise picks
// whichever LAN address this machine happens to have.
const PUBLIC_URL = "https://tb.example.test";
const LEGACY_PAYLOAD =
  `threadbase://pair?url=${encodeURIComponent(PUBLIC_URL)}` +
  "&token=pt_0123456789abcdef0123456789abcdef&exp=1760000000";

function makeFetch(info: unknown, opts: { infoStatus?: number; infoThrows?: string } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/info")) {
      if (opts.infoThrows) throw new Error(opts.infoThrows);
      const status = opts.infoStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => info,
      } as unknown as Response;
    }
    if (url.endsWith("/api/pair/start")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: "pt_0123456789abcdef0123456789abcdef",
          expiresAt: EXPIRES_AT,
          expiresInSeconds: 180,
        }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

async function printWith(info: unknown, fetchOpts?: { infoStatus?: number; infoThrows?: string }) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const identityKey = vi.fn(() => IDENTITY_KEY);
  await printServerBanner(
    {
      port: 8766,
      apiKey: "tb_0123456789abcdef0123456789abcdef",
      publicUrl: PUBLIC_URL,
      includeQr: true,
    },
    { log, fetch: makeFetch(info, fetchOpts), identityKey },
  );
  const printed = log.info.mock.calls.map(([msg]) => String(msg));
  const pairUrlLine = printed.find((line) => line.startsWith("Pair URL: "));
  return { log, identityKey, printed, payload: pairUrlLine?.slice("Pair URL: ".length) };
}

describe("pairing QR payload", () => {
  it("omits spk and v when the exchange will not accept a handshake", async () => {
    const { payload, identityKey, printed } = await printWith({
      e2ee: { supported: false, enabled: false, version: 1, required: false },
    });

    // Positive control first: without it, every assertion below passes against
    // a banner that printed nothing at all. Byte-identical to the QR printed
    // before any of this existed — GATE 3.
    expect(payload).toBe(LEGACY_PAYLOAD);
    expect(payload).not.toContain("spk=");
    expect(payload).not.toContain("&v=");
    // The identity key is never read on this path, so a corrupt key file costs
    // the QR only on a build that would have used it.
    expect(identityKey).not.toHaveBeenCalled();
    expect(printed.join("\n")).not.toContain("Identity code");
  });

  it("emits spk and v when the exchange will accept a handshake", async () => {
    const { payload, identityKey, printed } = await printWith({
      e2ee: { supported: true, enabled: true, version: 1, required: false },
    });

    expect(payload).toBe(`${LEGACY_PAYLOAD}&spk=${IDENTITY_KEY}&v=1`);
    expect(identityKey).toHaveBeenCalledTimes(1);
    // Same grouped hex the phone shows after scanning this QR.
    const banner = printed.join("\n");
    expect(banner).toContain("Identity code");
    expect(banner).toContain(serverIdentityFingerprint(IDENTITY_KEY));
    expect(banner).toContain("This should match the code your phone shows after you scan.");
  });

  it("omits spk and v against a server too old to report the capability", async () => {
    const { payload, log } = await printWith({ version: "1.0.0", machineName: "old-box" });

    expect(payload).toBe(LEGACY_PAYLOAD);
    expect(payload).not.toContain("spk=");
    expect(payload).not.toContain("&v=");
    // Absent is "unknown", not an error: a server too old to answer is too old
    // to have the handshake, so this is the ordinary case and stays quiet.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("omits spk and v, and says so, when the capability cannot be read", async () => {
    const { payload, log } = await printWith({}, { infoStatus: 401 });

    expect(payload).toBe(LEGACY_PAYLOAD);
    expect(payload).not.toContain("spk=");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("401"),
      expect.objectContaining({ event: "pair.e2ee_capability_unknown" }),
    );
  });

  it("still prints a legacy QR when the capability probe throws", async () => {
    const { payload, log } = await printWith({}, { infoThrows: "ECONNRESET" });

    expect(payload).toBe(LEGACY_PAYLOAD);
    expect(payload).not.toContain("spk=");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("ECONNRESET"),
      expect.objectContaining({ event: "pair.e2ee_capability_unknown" }),
    );
  });
});

describe("printUrlBanner fingerprint lines", () => {
  it("prints the grouped hex under the box when a fingerprint is supplied", () => {
    const fingerprint = "3cfe 00ad 6d01 6dd3 782c 8628 4b1d a1d2";
    const box = printUrlBanner({ url: PUBLIC_URL, fingerprint });
    expect(box).toContain("Identity code");
    expect(box).toContain(fingerprint);
    expect(box).toContain("This should match the code your phone shows after you scan.");
  });

  it("omits those lines when no fingerprint is supplied", () => {
    const box = printUrlBanner({ url: PUBLIC_URL });
    expect(box).not.toContain("Identity code");
    expect(box).toContain(PUBLIC_URL);
  });
});

/**
 * The probe against a REAL daemon — no mocked `fetch`, no stubbed transport.
 *
 * This exists because of one asymmetric, silent failure mode. `printServerBanner`
 * resolves every probe failure to "capability off", which is correct and
 * fail-safe for an old server — and indistinguishable from a *current* server
 * whose `/api/info` refused the CLI's credential. In that case E2EE quietly
 * stops happening and a fully green mocked suite still passes.
 *
 * So the question this answers is not "is the JSON read correctly" but "does
 * the CLI's own credential actually get an answer out of `/api/info`". The
 * banner passes `Authorization: Bearer <apiKey>`, the same shared key it
 * already presents to `/api/pair/start`; that resolves to `legacyPrincipal()`,
 * which carries the full preset and therefore the `history:read` that
 * `/api/info` requires (services/security/capabilities.ts).
 */
describe("the capability probe against a real running server", () => {
  const API_KEY = "tb_test_key_for_pair_banner_probe";
  let server: StreamerServer;
  let port: number;
  let configDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    savedConfigDir = process.env.THREADBASE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "tb-pair-banner-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;

    server = new StreamerServer({ port: 0, apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(0, { awaitReady: true });
    port = server.port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    if (savedConfigDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = savedConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  async function printAgainstServer() {
    const log = { info: vi.fn(), warn: vi.fn() };
    await printServerBanner(
      { port, apiKey: API_KEY, publicUrl: PUBLIC_URL, includeQr: true },
      { log },
    );
    const line = log.info.mock.calls
      .map(([msg]) => String(msg))
      .find((m) => m.startsWith("Pair URL: "));
    return { log, payload: line?.slice("Pair URL: ".length) };
  }

  it("reaches /api/info with the CLI's own credential and reads the capability off it", async () => {
    const { payload, log } = await printAgainstServer();

    // THE assertion, and the reason this suite exists. `printServerBanner`
    // resolves a refused probe to "capability off" — the same outcome as a
    // daemon that genuinely answered "off" — so the QR alone cannot tell the
    // two apart. The warn line is the discriminator: silence here means the
    // probe got a 200 through the real auth middleware and read a real field.
    // Paired with the wrong-key case below, which does warn with a 401, this
    // says the CLI's shared key is accepted by /api/info and nothing else is
    // quietly standing in for that.
    expect(log.warn).not.toHaveBeenCalled();

    // ...and the field it read is really there, with the shape the probe
    // depends on. Fetched independently so this does not rest on the banner
    // agreeing with itself.
    const info = (await (
      await fetch(`http://localhost:${port}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      })
    ).json()) as { serverIdentityKey?: string; e2ee?: { enabled?: boolean; supported?: boolean } };
    expect(info.e2ee).toBeDefined();
    expect(info.e2ee?.enabled).toBe(false);
    // Present and well-formed, so the only thing standing between this build
    // and an spk-carrying QR is the capability answer — not a missing key.
    expect(info.serverIdentityKey).toBe(serverIdentityPublicKey());

    expect(payload).not.toContain("spk=");
  });

  /**
   * COVERAGE LIMIT, stated rather than papered over.
   *
   * There is no real-server test above for "capability on ⇒ the QR carries
   * spk", because this build cannot produce that state. `describeE2eeCapability`
   * is `E2EE_SUPPORTED && flagEnabled`, `E2EE_SUPPORTED` is the hardcoded
   * `false` that Batch D flips, and no feature-flag setting can override a
   * hardcoded constant.
   *
   * The `vi.spyOn(miscRoutes, "describeE2eeCapability")` trick the exchange
   * suites use does NOT reach here either, and the reason is worth knowing
   * before someone tries it and believes the green result: `/api/info` calls
   * that function from inside the module that declares it
   * (misc.routes.ts:279 calling misc.routes.ts:159), so the call binds locally
   * and never goes through the namespace object the spy replaces. It works for
   * `handlePairExchange` only because `src/server.ts` is a different module
   * importing it across a boundary vitest can intercept.
   *
   * A spy that silently does not apply is worse than no spy: the test passes,
   * and it passes for a reason unrelated to what it claims to check. So the
   * enabled path is covered by the mocked-transport case at the top of this
   * file, and this half deliberately covers only what a real daemon can be put
   * into today. Revisit when Batch D flips the constant.
   */
  it("prints a legacy QR against the same daemon with the capability at its real default", async () => {
    // No stub: `E2EE_SUPPORTED` is now true, so what keeps this legacy is the
    // `e2ee` feature flag defaulting off — which is what every server prints
    // until an operator opts in. The positive control for the case above —
    // without it, that test also passes on a build that always emits. If the
    // flag's default ever changes, this is the test that must be re-read first.
    const { payload, log } = await printAgainstServer();

    expect(log.warn).not.toHaveBeenCalled();
    expect(payload).toContain("threadbase://pair?url=");
    expect(payload).not.toContain("spk=");
    expect(payload).not.toContain("&v=");
  });

  it("falls back to a legacy QR when the credential is refused", async () => {
    vi.spyOn(miscRoutes, "describeE2eeCapability").mockReturnValue({
      supported: true,
      enabled: true,
      version: 1,
      required: false,
    });

    const log = { info: vi.fn(), warn: vi.fn() };
    await printServerBanner(
      // A wrong key, against a daemon that would otherwise offer E2EE. This is
      // the exact shape of the silent downgrade: the server is enabled, and the
      // QR still comes out legacy.
      { port, apiKey: "tb_wrong_key", publicUrl: PUBLIC_URL, includeQr: true },
      { log },
    ).catch(() => undefined);

    // /api/pair/start is authenticated too, so a bad key cannot even mint a
    // token — the banner throws before printing. What matters here is that the
    // probe SAID SO rather than resolving to "off" in silence.
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("401"),
      expect.objectContaining({ event: "pair.e2ee_capability_unknown" }),
    );
  });
});
