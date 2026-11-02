import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DevicesRepository,
  UNCONFIRMED_DEVICE_TTL_MS,
} from "../src/db/repositories/devices.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { IDLE_REAP_SWEEP_MS, StreamerServer } from "../src/server";

/**
 * #744 — a pairing whose msg2 never reached the phone leaves a full-capability
 * `devices` row nobody holds. The server revokes (not deletes) rows that were
 * never used within UNCONFIRMED_DEVICE_TTL_MS, at boot and on the idle-reaper
 * sweep.
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
        info: (msg: string, meta?: unknown, dest?: unknown) => {
          logLines.push({ msg, meta: (meta ?? {}) as Record<string, unknown>, dest });
          return real.info(msg, meta as never, dest as never);
        },
      };
    },
  };
});

const pruneLogs = () => logLines.filter((l) => l.meta.event === "devices.unconfirmed_pruned");

let dir: string;
let dbPath: string;
let server: StreamerServer | undefined;

const staticPub = (key: string) => Buffer.from(key.padEnd(32, "x")).toString("base64");

/** Rows written straight to the database, optionally while a server holds it. */
function seed(rows: { key: string; ageMs: number; used?: boolean }[]) {
  const store = RuntimeStore.open(dbPath);
  const repo = new DevicesRepository(store.getDatabase());
  const ids: Record<string, string> = {};
  for (const r of rows) {
    const created = Date.now() - r.ageMs;
    const { deviceId } = repo.register({
      publicKey: r.key,
      e2eeStaticPub: staticPub(r.key),
      e2eeVersion: 1,
      now: created,
    });
    ids[r.key] = deviceId;
    if (r.used) repo.touch(deviceId, created + 1_000);
  }
  store.close();
  return ids;
}

function readRevoked(): Record<string, number | null> {
  const store = RuntimeStore.open(dbPath);
  try {
    return Object.fromEntries(
      new DevicesRepository(store.getDatabase()).list().map((d) => [d.deviceId, d.revokedAt]),
    );
  } finally {
    store.close();
  }
}

const boot = async () => {
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
  });
  await server.listen(0, { awaitReady: true });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-prune-"));
  dbPath = join(dir, "runtime.db");
  logLines.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("unconfirmed device prune at boot", () => {
  it("revokes a stale never-used row, spares a used one and an in-flight one, and logs ids only", async () => {
    const ids = seed([
      { key: "stale", ageMs: UNCONFIRMED_DEVICE_TTL_MS + 60_000 },
      { key: "used", ageMs: UNCONFIRMED_DEVICE_TTL_MS * 5, used: true },
      { key: "fresh", ageMs: UNCONFIRMED_DEVICE_TTL_MS - 60_000 },
    ]);

    await boot();

    const revoked = readRevoked();
    expect(revoked[ids.stale]).not.toBeNull();
    expect(revoked[ids.used]).toBeNull();
    expect(revoked[ids.fresh]).toBeNull();

    const logs = pruneLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].meta.count).toBe(1);
    expect(logs[0].meta.deviceIds).toEqual([ids.stale]);
    expect(JSON.stringify(logs[0].meta)).not.toMatch(/static|token|key/i);
  });

  it("logs nothing when there is nothing to prune", async () => {
    seed([{ key: "fresh", ageMs: 1_000 }]);
    await boot();
    expect(pruneLogs()).toEqual([]);
  });
});

describe("unconfirmed device prune on the idle-reaper sweep", () => {
  it("runs from the same interval that reaps idle sessions", async () => {
    const intervals: { fn: () => void; ms: number | undefined }[] = [];
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      intervals.push({ fn, ms });
      return real(fn, ms);
    }) as typeof setInterval);

    await boot();
    // Written after boot, so only the sweep can see it.
    const ids = seed([{ key: "late", ageMs: UNCONFIRMED_DEVICE_TTL_MS + 60_000 }]);

    const sweep = intervals.find((i) => i.ms === IDLE_REAP_SWEEP_MS);
    expect(sweep).toBeDefined();
    sweep?.fn();

    expect(readRevoked()[ids.late]).not.toBeNull();
  });
});
