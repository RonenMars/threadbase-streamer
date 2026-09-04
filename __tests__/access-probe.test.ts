import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  type AccessProbeResult,
  describeAccessProbe,
  probeAccessGate,
  safeHost,
} from "../src/access-probe";
import { loadAccessServiceToken } from "../src/auth";
import { StreamerServer } from "../src/server";

const bootLog = vi.hoisted(() => [] as { msg: string; meta: Record<string, unknown> }[]);
vi.mock("../src/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger")>();
  return {
    ...actual,
    getLogger: (component?: string) => {
      const real = actual.getLogger(component);
      return {
        ...real,
        warn: (msg: string, meta?: unknown, dest?: unknown) => {
          bootLog.push({ msg, meta: (meta ?? {}) as Record<string, unknown> });
          return real.warn(msg, meta as never, dest as never);
        },
      };
    },
  };
});

/**
 * The boot-time Access probe (D2 row 9, 2026-09-02).
 *
 * The real probe, the real message builder and the real server.yaml loader.
 * Only the network is faked, and it has to be: the transition under test is
 * "what the edge answered", so the edge is the input, not a seam inside the
 * logic. The redirect fixtures below are the actual shape Cloudflare returned
 * to a live probe of `tb-secured.example.com`.
 */

const LOGIN =
  "https://example.cloudflareaccess.com/cdn-cgi/access/login/tb-secured.example.com" +
  "?kid=a1a9e5f8&meta=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.PAYLOAD.SIGNATURE&redirect_url=%2Fhealthz";

const reply = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

/** A fetch that records what it was asked, and answers from a script. */
function scriptedFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url: String(input), headers });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("what the probe concludes", () => {
  it("says nothing when an unauthenticated request reaches the server", async () => {
    const { impl, calls } = scriptedFetch(reply(200));
    const result = await probeAccessGate({ publicUrl: "https://example.test", fetchImpl: impl });

    expect(result).toEqual({ kind: "open", status: 200 });
    expect(describeAccessProbe(result)).toBeNull();
    // /healthz specifically: it needs no credential, so the answer describes
    // the path in front of the server rather than authorization.
    expect(calls[0].url).toBe("https://example.test/healthz");
  });

  it("recognises the Access login redirect and names both remedies", async () => {
    const { impl } = scriptedFetch(reply(302, { location: LOGIN }));
    const result = await probeAccessGate({ publicUrl: "https://example.test", fetchImpl: impl });

    expect(result.kind).toBe("gated");
    const message = describeAccessProbe(result) ?? "";
    expect(message).toContain("no Authorization header");
    expect(message).toContain("removing Access from this hostname");
    expect(message).toContain("service token");
  });

  it("does NOT cry wolf over a redirect that is not an Access login", async () => {
    // A plain http→https or trailing-slash redirect must read as open. This is
    // the false positive that would make the warning noise, and noise is how a
    // real warning gets ignored.
    const { impl } = scriptedFetch(reply(301, { location: "https://example.test/healthz/" }));
    const result = await probeAccessGate({ publicUrl: "https://example.test", fetchImpl: impl });

    expect(result).toEqual({ kind: "open", status: 301 });
    expect(describeAccessProbe(result)).toBeNull();
  });

  it("stays silent when the public URL cannot be reached at all", async () => {
    // An offline laptop is a different problem with its own symptoms. Warning
    // about a gate here would be a guess.
    const { impl } = scriptedFetch(new Error("getaddrinfo ENOTFOUND example.test"));
    const result = await probeAccessGate({ publicUrl: "https://example.test", fetchImpl: impl });

    expect(result.kind).toBe("unknown");
    expect(describeAccessProbe(result)).toBeNull();
  });

  it("trims a trailing slash rather than probing a doubled path", async () => {
    const { impl, calls } = scriptedFetch(reply(200));
    await probeAccessGate({ publicUrl: "https://example.test/", fetchImpl: impl });
    expect(calls[0].url).toBe("https://example.test/healthz");
  });
});

describe("with a service token configured", () => {
  it("reports that the token satisfies the gate", async () => {
    const { impl, calls } = scriptedFetch(reply(302, { location: LOGIN }), reply(200));
    const result = await probeAccessGate({
      publicUrl: "https://example.test",
      serviceToken: { clientId: "id.access", clientSecret: "secret" },
      fetchImpl: impl,
    });

    expect(result).toMatchObject({ kind: "gated", serviceTokenAccepted: true });
    expect(describeAccessProbe(result)).toContain("DOES satisfy");
    // The headers Cloudflare expects, spelled exactly.
    expect(calls[1].headers["CF-Access-Client-Id"]).toBe("id.access");
    expect(calls[1].headers["CF-Access-Client-Secret"]).toBe("secret");
    // The unauthenticated probe comes first: the operator needs to know a gate
    // exists even when their token works, because devices do not hold it.
    expect(calls[0].headers["CF-Access-Client-Id"]).toBeUndefined();
  });

  it("reports that the token does NOT satisfy the gate", async () => {
    const { impl } = scriptedFetch(
      reply(302, { location: LOGIN }),
      reply(302, { location: LOGIN }),
    );
    const result = await probeAccessGate({
      publicUrl: "https://example.test",
      serviceToken: { clientId: "id.access", clientSecret: "secret" },
      fetchImpl: impl,
    });

    expect(result).toMatchObject({ kind: "gated", serviceTokenAccepted: false });
    expect(describeAccessProbe(result)).toContain("does NOT satisfy");
  });

  it("falls back to 'gate found, token unverified' when the second request fails", async () => {
    const { impl } = scriptedFetch(reply(302, { location: LOGIN }), new Error("socket hang up"));
    const result = await probeAccessGate({
      publicUrl: "https://example.test",
      serviceToken: { clientId: "id.access", clientSecret: "secret" },
      fetchImpl: impl,
    });

    expect(result.kind).toBe("gated");
    expect((result as { serviceTokenAccepted?: boolean }).serviceTokenAccepted).toBeUndefined();
    expect(describeAccessProbe(result)).toContain("removing Access");
  });
});

describe("what reaches the log", () => {
  it("keeps the signed JWT out of it, and the host in", () => {
    // The redirect's query string carries identity metadata about the account
    // and the request. The host is the diagnostic; the rest is not ours to
    // write into a file that gets attached to bug reports.
    expect(safeHost(LOGIN)).toBe("example.cloudflareaccess.com");
    expect(safeHost(LOGIN)).not.toContain("meta=");
    expect(safeHost(LOGIN)).not.toContain("PAYLOAD");
    expect(safeHost(undefined)).toBeUndefined();
    expect(safeHost("not a url")).toBeUndefined();
  });
});

describe("reading the service token from server.yaml", () => {
  let dir: string;
  let saved: string | undefined;

  const writeConfig = (body: string) => {
    writeFileSync(join(dir, "server.yaml"), body);
  };

  beforeEach(() => {
    saved = process.env.THREADBASE_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), "tb-access-token-"));
    process.env.THREADBASE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a well-formed one line entry", () => {
    writeConfig(
      'api_key: tb_x\naccess_service_token: {"client_id":"abc.access","client_secret":"s3cret"}\n',
    );
    expect(loadAccessServiceToken()).toEqual({ clientId: "abc.access", clientSecret: "s3cret" });
  });

  it("is absent when the key is absent", () => {
    writeConfig("api_key: tb_x\n");
    expect(loadAccessServiceToken()).toBeUndefined();
  });

  it("costs the probe's second half, never the boot, when the line is malformed", () => {
    writeConfig("api_key: tb_x\naccess_service_token: {not json\n");
    expect(loadAccessServiceToken()).toBeUndefined();
  });

  it("refuses a half-filled entry rather than sending an empty credential", () => {
    writeConfig('api_key: tb_x\naccess_service_token: {"client_id":"abc.access"}\n');
    expect(loadAccessServiceToken()).toBeUndefined();
    writeConfig('api_key: tb_x\naccess_service_token: {"client_id":"","client_secret":"s"}\n');
    expect(loadAccessServiceToken()).toBeUndefined();
  });
});

describe("the result type is exhaustive", () => {
  it("produces a message for exactly the gated case", () => {
    const cases: AccessProbeResult[] = [
      { kind: "open", status: 200 },
      { kind: "unknown", reason: "offline" },
      { kind: "gated", status: 302, location: LOGIN },
    ];
    expect(cases.map((c) => describeAccessProbe(c) !== null)).toEqual([false, false, true]);
  });
});

/**
 * The boot wiring: a real `StreamerServer` reaching a faked edge, so the flag,
 * the publicUrl condition and the e2ee condition are exercised through the
 * production path rather than by calling the probe directly.
 */
describe("at boot", () => {
  let dir: string;
  let server: StreamerServer | undefined;
  let savedConfig: string | undefined;
  let fetchCalls: string[];

  const boot = async (opts: {
    publicUrl?: string;
    featureFlags?: Record<string, boolean>;
    edge?: Response;
  }) => {
    fetchCalls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return opts.edge ?? new Response(null, { status: 200 });
    }) as unknown as typeof fetch);
    server = new StreamerServer({
      codexRoots: [],
      scannerPersistent: false,
      port: 0,
      apiKey: "tb_0123456789abcdef0123456789abcdef",
      localNoAuth: false,
      verbose: false,
      cacheDir: join(dir, "cache"),
      runtimeDbPath: join(dir, "runtime.db"),
      scanProfiles: [],
      publicUrl: opts.publicUrl,
      featureFlags: opts.featureFlags,
    } as never);
    // biome-ignore lint/style/noNonNullAssertion: assigned immediately above
    await server!.listen(0, { awaitReady: true });
    // The probe is deliberately fire-and-forget, so give its microtasks a turn.
    await new Promise((r) => setTimeout(r, 50));
  };

  const gateWarnings = () => bootLog.filter((l) => l.meta.event === "access.gate_detected");

  beforeEach(() => {
    bootLog.length = 0;
    savedConfig = process.env.THREADBASE_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), "tb-access-boot-"));
    process.env.THREADBASE_CONFIG_DIR = dir;
    writeFileSync(join(dir, "server.yaml"), "api_key: tb_0123456789abcdef0123456789abcdef\n");
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.restoreAllMocks();
    if (savedConfig === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = savedConfig;
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns when a gate answers the server's own public URL", async () => {
    await boot({
      publicUrl: "https://example.test",
      featureFlags: { e2ee: true },
      edge: reply(302, { location: LOGIN }),
    });

    expect(fetchCalls).toContain("https://example.test/healthz");
    expect(gateWarnings()).toHaveLength(1);
    expect(gateWarnings()[0].meta.gateHost).toBe("example.cloudflareaccess.com");
    expect(JSON.stringify(gateWarnings()[0])).not.toContain("PAYLOAD");
  });

  it("POSITIVE CONTROL — the same boot with an open edge warns about nothing", async () => {
    await boot({
      publicUrl: "https://example.test",
      featureFlags: { e2ee: true },
      edge: reply(200),
    });
    expect(fetchCalls).toContain("https://example.test/healthz");
    expect(gateWarnings()).toEqual([]);
  });

  it("does not probe at all when the flag is off", async () => {
    await boot({
      publicUrl: "https://example.test",
      featureFlags: { e2ee: true, accessProbe: false },
      edge: reply(302, { location: LOGIN }),
    });
    expect(fetchCalls).not.toContain("https://example.test/healthz");
    expect(gateWarnings()).toEqual([]);
  });

  it("does not probe when encryption is off — no device would be refused by a gate", async () => {
    await boot({
      publicUrl: "https://example.test",
      featureFlags: { e2ee: false },
      edge: reply(302, { location: LOGIN }),
    });
    expect(fetchCalls).not.toContain("https://example.test/healthz");
    expect(gateWarnings()).toEqual([]);
  });

  it("does not probe when there is no public URL — there is no edge to ask", async () => {
    await boot({ featureFlags: { e2ee: true }, edge: reply(302, { location: LOGIN }) });
    expect(fetchCalls.some((u) => u.endsWith("/healthz"))).toBe(false);
    expect(gateWarnings()).toEqual([]);
  });
});
