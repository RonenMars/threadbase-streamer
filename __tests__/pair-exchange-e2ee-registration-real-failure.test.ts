import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Item 4 of #590's remaining checklist: no orphan device row, and the pair
 * token stays spent, when mandatory E2EE registration fails.
 *
 * `pair-exchange-authenticated.test.ts`'s "device registration is mandatory
 * on the E2EE path only" describe block covers the same branch with
 * `vi.spyOn(repo, "register").mockImplementation(() => { throw ... })` — a
 * stub of the very method under test. That proves the branch exists; it does
 * not prove the real SQLite layer fails the way the branch assumes, or that
 * nothing was written before it threw. This file injects the failure at the
 * real boundary instead: the actual better-sqlite3 connection underneath
 * `DevicesRepository` is closed, so `insertStmt.run` throws for real inside
 * the production route.
 *
 * Its own file, not an addition to `pair-exchange-authenticated.test.ts`,
 * because asserting on `pair.token_replayed` needs the module-scoped logger
 * mock `pair-token-replay-log.test.ts` also isolates for the same reason —
 * mocking `../src/logger` here would silence every other suite that shares a
 * module registry with it.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: Record<string, unknown> }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: Record<string, unknown>) =>
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

const { StreamerServer } = await import("../src/server");
const miscRoutes = await import("../src/api/routes/misc.routes");
const { generateKeyPair, PAIR_PROLOGUE, pskFromPairToken, writeMessage1 } = await import(
  "../src/e2ee/noise"
);
const { loadOrCreateServerIdentity } = await import("../src/server-identity");

type KeyPair = ReturnType<typeof generateKeyPair>;
type RuntimeStoreLike = { getDatabase(): InstanceType<typeof Database> };

const API_KEY = "tb_test_key_for_real_registration_failure";
const replayWarnings = () => h.calls.filter((c) => c.fields?.event === "pair.token_replayed");

describe("a real device-registration failure on the E2EE path", () => {
  let server: InstanceType<typeof StreamerServer>;
  let baseUrl: string;
  let configDir: string;
  let savedConfigDir: string | undefined;
  let serverStaticPub: Buffer;
  let clientStatic: KeyPair;

  beforeEach(async () => {
    h.calls.length = 0;
    savedConfigDir = process.env.THREADBASE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "tb-e2ee-reg-fail-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
    serverStaticPub = Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url");
    clientStatic = generateKeyPair();

    server = new StreamerServer({ port: 0, apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;

    vi.spyOn(miscRoutes, "describeE2eeCapability").mockReturnValue({
      supported: true,
      enabled: true,
      version: 1,
      required: false,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // The mutation below closes the real db handle, so a second close during
    // teardown is expected to no-op or throw depending on how far a test got.
    try {
      await server.close();
    } catch {
      // already closed by the test's own mutation
    }
    if (savedConfigDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = savedConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  async function mintToken(): Promise<string> {
    const r = await fetch(`${baseUrl}/api/pair/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    return ((await r.json()) as { token: string }).token;
  }

  const post = (body: unknown) =>
    fetch(`${baseUrl}/api/pair/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("500s with no device credential, leaves no row, and refuses a same-token retry as replayed", async () => {
    const token = await mintToken();
    const initiator = writeMessage1({
      prologue: PAIR_PROLOGUE,
      staticKeyPair: clientStatic,
      responderStaticPub: serverStaticPub,
      psk: pskFromPairToken(token),
      payload: Buffer.from(JSON.stringify({ v: 1, readOnly: false }), "utf-8"),
    });

    // Real-path failure: close the actual better-sqlite3 handle underneath
    // `DevicesRepository`, so `insertStmt.run` throws for real rather than a
    // stubbed `register`.
    const runtimeStore = (server as unknown as { runtimeStore: RuntimeStoreLike | null })
      .runtimeStore;
    const runtimeDbPath = (server as unknown as { runtimeDbPath: string }).runtimeDbPath;
    if (!runtimeStore) throw new Error("runtimeStore missing; this suite cannot say anything");
    runtimeStore.getDatabase().close();

    // (a) status + body shape: a failed registration must not hand back
    // anything a client could mistake for a completed pairing.
    const res = await post({
      token,
      clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
      e2ee: { v: 1, noise: initiator.message.toString("base64") },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("E2EE_REGISTRATION_FAILED");
    expect(body.e2ee).toBeUndefined();
    expect(body.deviceToken).toBeUndefined();
    expect(body.ciphertext).toBeUndefined();

    // (b) no orphan row: reopen the on-disk file fresh (the connection above
    // is closed, the file is not) to prove the failed insert committed
    // nothing, rather than trusting the HTTP response shape alone.
    const reopened = new Database(runtimeDbPath, { readonly: true });
    const rows = reopened.prepare("SELECT COUNT(*) as c FROM devices").get() as { c: number };
    expect(rows.c).toBe(0);
    reopened.close();

    // (c) the token stays spent: a retry with the SAME token is a replay, not
    // an unknown token, and the operator-facing signal fires from the real
    // logger — not a spy standing in for it.
    const retry = await post({
      token,
      clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
    });
    expect(retry.status).toBe(401);
    const retryBody = (await retry.json()) as { error?: string };
    expect(retryBody.error).toContain("used");

    const warned = replayWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0].level).toBe("warn");
  });
});
