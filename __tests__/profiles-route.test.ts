import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "fs";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { createHonoApp } from "../src/api/app";
import type { ApiDeps } from "../src/api/types/api-deps";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { RuntimeStore } from "../src/db/runtime-store";

/**
 * GET /api/profiles lists the configured scan profiles (#511) and never
 * the absolute `configDir` behind them, under any capability.
 */

const KEY = "tb_0123456789abcdef0123456789abcdef";
const PROFILES = [
  {
    id: "work",
    label: "Work",
    configDir: "/Users/someone/.claude-work",
    enabled: true,
    emoji: "💼",
  },
  {
    id: "play",
    label: "Play",
    configDir: "/Users/someone/.claude-play",
    enabled: false,
    emoji: "🎮",
  },
];

describe("GET /api/profiles", () => {
  let dir: string;
  let store: RuntimeStore;
  let repo: DevicesRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-profiles-"));
    store = RuntimeStore.open(join(dir, "runtime.db"));
    repo = new DevicesRepository(store.getDatabase());
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const servers: ReturnType<typeof serve>[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  const appWith = async (scanProfiles?: typeof PROFILES) => {
    const server = serve({
      fetch: createHonoApp({
        apiKey: KEY,
        localNoAuth: false,
        logMenubarRequests: false,
        devicesRepo: () => repo,
        scanProfiles,
      } as unknown as ApiDeps).fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const get = async (base: Promise<string>, token: string) =>
    fetch(`${await base}/api/profiles`, { headers: { authorization: `Bearer ${token}` } });

  it("answers [] when no profiles are configured", async () => {
    const res = await get(appWith(), KEY);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("[]");
  });

  it("lists every profile in config order with exactly id, label, emoji, enabled", async () => {
    const res = await get(appWith(PROFILES), KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body).toEqual([
      { id: "work", label: "Work", emoji: "💼", enabled: true },
      { id: "play", label: "Play", emoji: "🎮", enabled: false },
    ]);
    expect(body.map((p) => Object.keys(p).sort())).toEqual([
      ["emoji", "enabled", "id", "label"],
      ["emoji", "enabled", "id", "label"],
    ]);
  });

  it.each([
    [
      "history:read device token",
      () => repo.register({ publicKey: "ro", preset: "read-only" }).deviceToken,
    ],
    ["admin device token", () => repo.register({ publicKey: "full", preset: "full" }).deviceToken],
    ["shared API key", () => KEY],
  ])("never sends configDir to a %s", async (_name, token) => {
    const res = await get(appWith(PROFILES), token());
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("configDir");
    for (const p of PROFILES) expect(raw).not.toContain(p.configDir);
    expect(raw).not.toContain("/Users/someone");
  });

  it("rejects a bad key with 401", async () => {
    const res = await get(appWith(PROFILES), "tb_ffffffffffffffffffffffffffffffff");
    expect(res.status).toBe(401);
  });
});
