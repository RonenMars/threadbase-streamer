import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "fs";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { applyNoE2ee } from "../cli/no-e2ee";
import { createHonoApp } from "../src/api/app";
import { createMiscRoutes } from "../src/api/routes/misc.routes";
import type { ApiDeps } from "../src/api/types/api-deps";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { generateKeyPair } from "../src/e2ee/noise";
import { FEATURE_FLAG_LIST, resolveFeatureFlags } from "../src/feature-flags";
import { StreamerServer } from "../src/server";

/**
 * R1 — `--no-e2ee` (design.md §6.3–§6.5, dilemmas.md D-8).
 *
 * The real Commander value shape, the real flag resolver, a real `devices`
 * table with real pinned rows, and a real `StreamerServer` boot reading the
 * bytes its own logger emits. Nothing about the transition under test is
 * stubbed.
 */

const logLines = vi.hoisted(
  () => [] as { msg: string; meta: Record<string, unknown>; dest?: unknown }[],
);
vi.mock("../src/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger")>();
  return {
    ...actual,
    getLogger: (component?: string) => {
      const real = actual.getLogger(component);
      return {
        ...real,
        warn: (msg: string, meta?: unknown, dest?: unknown) => {
          logLines.push({ msg, meta: (meta ?? {}) as Record<string, unknown>, dest });
          return real.warn(msg, meta as never, dest as never);
        },
      };
    },
  };
});

const disabledWarnings = () => logLines.filter((l) => l.meta.event === "e2ee.disabled");

describe("--no-e2ee, folded into the CLI rung", () => {
  it("turns the flag off when it is the only spelling used", () => {
    expect(applyNoE2ee(undefined, false)).toEqual({ values: { e2ee: false } });
  });

  it("changes nothing when the option is absent", () => {
    // Commander leaves a negated option `true` when it was never passed, and an
    // undefined `featureFlags` must stay undefined so the next rung decides.
    expect(applyNoE2ee(undefined, true)).toEqual({ values: undefined });
    expect(applyNoE2ee({ ptyHost: true }, true)).toEqual({ values: { ptyHost: true } });
  });

  it("agrees with the other spelling of itself", () => {
    expect(applyNoE2ee({ e2ee: false }, false)).toEqual({ values: { e2ee: false } });
  });

  it("refuses the boot when the two spellings contradict each other", () => {
    const applied = applyNoE2ee({ e2ee: true }, false);
    expect(applied.error).toBe("--no-e2ee contradicts --feature e2ee=true; pass one or the other");
    // The value is left alone: the caller exits, and a half-applied flag is
    // worse than none.
    expect(applied.values).toEqual({ e2ee: true });
  });

  it("preserves the other flags it travels with", () => {
    expect(applyNoE2ee({ ptyHost: true }, false)).toEqual({
      values: { ptyHost: true, e2ee: false },
    });
  });
});

describe("D-8 — a serve option and nothing else", () => {
  it("adds no environment variable of its own", () => {
    // The registry is the only place an env name may be declared, and `e2ee`
    // keeps exactly the one it already had.
    const e2ee = FEATURE_FLAG_LIST.filter((f) => f.id === "e2ee");
    expect(e2ee.map((f) => f.env)).toEqual(["THREADBASE_FEATURE_E2EE"]);
  });

  it("cannot be persisted through server.yaml — the CLI rung outranks it", () => {
    const resolved = resolveFeatureFlags({
      cli: { e2ee: false },
      yaml: { e2ee: true },
      env: {},
    });
    expect(resolved.values.e2ee).toBe(false);
    expect(resolved.sources.e2ee).toBe("cli");
  });

  it("does NOT beat the environment variable, which is the documented precedence", () => {
    // The D-8 vs §6.5 collision, implemented as written rather than excepted:
    // `env` outranks `cli`, so this leaves encryption ON. R2 escalates the
    // collision to the user; R1 must not pre-empt it by carving a special case.
    const resolved = resolveFeatureFlags({
      cli: { e2ee: false },
      env: { THREADBASE_FEATURE_E2EE: "1" },
    });
    expect(resolved.values.e2ee).toBe(true);
    expect(resolved.sources.e2ee).toBe("env");
  });
});

describe("what a disabled run tells a client and an operator", () => {
  let dir: string;
  let store: RuntimeStore;
  let repo: DevicesRepository;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;

  const deps = (values: { e2ee: boolean }, source: "cli" | "default") =>
    ({
      apiKey: "tb_0123456789abcdef0123456789abcdef",
      localNoAuth: false,
      logMenubarRequests: false,
      devicesRepo: () => repo,
      featureFlagsConfig: () => ({ registry: [], values, sources: { e2ee: source } }),
    }) as unknown as ApiDeps;

  /** A pinned device: a real row with a real Noise static key, which is what sets `e2ee_required`. */
  const pinDevice = () =>
    repo.register({
      publicKey: "legacy-public-key",
      e2eeStaticPub: generateKeyPair().publicKeyRaw.toString("base64"),
      e2eeVersion: 1,
    });

  const start = async (values: { e2ee: boolean }, source: "cli" | "default") => {
    server = serve({
      fetch: createHonoApp(deps(values, source)).fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    await new Promise((r) => server.once("listening", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  /** The real `/api/info` route, with the minimum around it that route needs. */
  const info = async (values: { e2ee: boolean }, source: "cli" | "default") => {
    const app = createMiscRoutes({
      publicUrl: null,
      sessionStore: { list: () => [] } as never,
      ptyAttachedIds: () => new Set<string>(),
      rotateApiKey: () => ({ newKey: "x", persisted: false }),
      localNoAuth: true,
      pushRepo: () => null,
      liveActivityPushEnabled: () => false,
      featureFlagsConfig: () => ({ registry: [], values, sources: { e2ee: source } }),
    } as never);
    const res = await app.request("/api/info");
    return (await res.json()) as {
      e2ee: { supported: boolean; enabled: boolean; reason?: string };
    };
  };

  beforeEach(() => {
    logLines.length = 0;
    dir = mkdtempSync(join(tmpdir(), "tb-no-e2ee-"));
    store = RuntimeStore.open(join(dir, "runtime.db"));
    repo = new DevicesRepository(store.getDatabase());
  });

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the flag the operator actually typed, not the three ways to switch it on", async () => {
    const { e2ee } = await info({ e2ee: false }, "cli");
    expect(e2ee.supported).toBe(true);
    expect(e2ee.enabled).toBe(false);
    expect(e2ee.reason).toBe("disabled by --no-e2ee (or --feature e2ee=false) for this run");
  });

  it("keeps the registry wording when nothing on the command line decided it", async () => {
    expect((await info({ e2ee: false }, "default")).e2ee.reason).toContain(
      "THREADBASE_FEATURE_E2EE=1",
    );
  });

  it("POSITIVE CONTROL — an enabled run reports enabled with no reason at all", async () => {
    const { e2ee } = await info({ e2ee: true }, "cli");
    expect(e2ee.enabled).toBe(true);
    expect(e2ee.reason).toBeUndefined();
  });

  it("NEGATIVE CONTROL — the flag refuses a pinned device, it does not un-pin one", async () => {
    const { deviceId, deviceToken } = pinDevice();
    await start({ e2ee: false }, "cli");

    const res = await fetch(`${baseUrl}/api/profiles`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    // Turning encryption off does not turn a pinned device into an unpinned
    // one: it is still refused, and its row still says so afterwards. A flag
    // that silently cleared the pin would downgrade a device the user pinned
    // on purpose — the stop-work case in this track's brief.
    expect(res.status).toBe(426);
    expect(repo.get(deviceId)?.e2ee_required).toBe(1);
  });
});

describe("the boot warning", () => {
  let dir: string;
  let dbPath: string;
  let server: StreamerServer | undefined;

  const boot = async (featureFlags?: { e2ee: boolean }) => {
    server = new StreamerServer({
      codexRoots: [],
      scannerPersistent: false,
      port: 0,
      apiKey: "tb_0123456789abcdef0123456789abcdef",
      localNoAuth: false,
      verbose: false,
      cacheDir: join(dir, "cache"),
      runtimeDbPath: dbPath,
      scanProfiles: [],
      featureFlags,
    });
    await server.listen(0, { awaitReady: true });
  };

  /** N pinned device rows, written before the server opens the same database. */
  const pin = (n: number) => {
    const store = RuntimeStore.open(dbPath);
    const repo = new DevicesRepository(store.getDatabase());
    const ids = Array.from({ length: n }, () =>
      repo.register({
        publicKey: "legacy-public-key",
        e2eeStaticPub: generateKeyPair().publicKeyRaw.toString("base64"),
        e2eeVersion: 1,
      }),
    );
    store.close();
    return ids;
  };

  beforeEach(() => {
    logLines.length = 0;
    dir = mkdtempSync(join(tmpdir(), "tb-no-e2ee-boot-"));
    dbPath = join(dir, "runtime.db");
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("says what is readable and how many devices this run refuses", async () => {
    pin(2);
    await boot({ e2ee: false });

    expect(disabledWarnings()).toHaveLength(1);
    const [warning] = disabledWarnings();
    expect(warning.msg).toContain("Transport encryption is OFF for this run");
    expect(warning.msg).toContain("readable");
    expect(warning.msg).toContain("Cloudflare edge");
    expect(warning.msg).toContain("2 paired devices require it");
    expect(warning.meta.pinnedDevices).toBe(2);
    expect(warning.meta.reason).toBe("cli");
    // `both`, not `console`. The brief asks for `e2ee.disabled` in the JSON log,
    // and `dest: "console"` routes INSTEAD of pino (`src/logger.ts:48-55`) — so
    // a console-only line silently fails that requirement while still looking
    // right in a terminal.
    expect(warning.dest).toBe("both");
  });

  it("counts the rows that require encryption, not every device", async () => {
    const [pinned] = pin(1);
    const store = RuntimeStore.open(dbPath);
    const repo = new DevicesRepository(store.getDatabase());
    // An unpinned device — no Noise static key, so `e2ee_required` is 0 — and a
    // revoked pinned one, which is already refused for a different reason.
    repo.register({ publicKey: "legacy-only" });
    const { deviceId: revoked } = (() => {
      const d = repo.register({
        publicKey: "legacy-public-key",
        e2eeStaticPub: generateKeyPair().publicKeyRaw.toString("base64"),
        e2eeVersion: 1,
      });
      repo.revoke(d.deviceId);
      return d;
    })();
    expect(revoked).toBeTruthy();
    expect(pinned).toBeTruthy();
    store.close();

    await boot({ e2ee: false });

    expect(disabledWarnings()[0]?.meta.pinnedDevices).toBe(1);
    expect(disabledWarnings()[0]?.msg).toContain("1 paired device requires it");
  });

  it("still warns when no device is pinned, and says so", async () => {
    await boot({ e2ee: false });

    expect(disabledWarnings()).toHaveLength(1);
    expect(disabledWarnings()[0].msg).toContain("no paired device requires it");
    expect(disabledWarnings()[0].meta.pinnedDevices).toBe(0);
  });

  it("POSITIVE CONTROL — a boot that did not disable it warns about nothing", async () => {
    pin(2);
    await boot(undefined);

    expect(disabledWarnings()).toEqual([]);
  });
});
