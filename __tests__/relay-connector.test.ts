import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/e2ee/noise";
import { RelayConnector } from "../src/relay/connector";
import { StreamerServer } from "../src/server";
import { loadOrCreateServerIdentity } from "../src/server-identity";
import { FakeRelay } from "./helpers/fake-relay";

/**
 * The streamer's half of the relay tunnel handshake, against a stand-in relay
 * built from the same Noise responder the relay uses. The confirmation check
 * below is the relay's, so a connector that sends anything else fails here.
 */

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const FAST = { minMs: 20, maxMs: 40 };

describe("RelayConnector", () => {
  let relay: FakeRelay;
  let connector: RelayConnector;
  const streamer = generateKeyPair();

  beforeEach(async () => {
    relay = await new FakeRelay().start();
  });
  afterEach(async () => {
    connector?.stop();
    await relay.kill().catch(() => {});
  });

  const connect = (relayPublicKey = relay.keyPair.publicKeyRaw) => {
    connector = new RelayConnector({
      url: relay.url,
      relayPublicKey,
      keyPair: streamer,
      backoff: FAST,
    });
    connector.start();
  };

  it("attaches with a confirmation the relay accepts, under its own key", async () => {
    connect();
    await waitFor(() => relay.confirmedKeys.length === 1);
    await waitFor(() => connector.state === "connected");
    expect(relay.confirmedKeys[0]).toBe(streamer.publicKeyRaw.toString("base64url"));
  });

  it("reports authentication_failed when the pinned relay key is wrong", async () => {
    connect(generateKeyPair().publicKeyRaw);
    await waitFor(() => connector.state === "authentication_failed");
    expect(relay.confirmedKeys).toEqual([]);
  });

  it("reports unsupported_protocol when the relay offers none of ours", async () => {
    relay.mode = "unsupported";
    connect();
    await waitFor(() => connector.state === "unsupported_protocol");
  });

  it("reconnects after the relay dies and comes back", async () => {
    connect();
    await waitFor(() => connector.state === "connected");
    const port = relay.port;
    await relay.kill();
    await waitFor(() => connector.state === "reconnecting");
    relay = await new FakeRelay(relay.keyPair).start(port);
    await waitFor(() => connector.state === "connected");
    expect(relay.confirmedKeys).toHaveLength(1);
  });
});

describe("a streamer with the relay flag", () => {
  const API_KEY = "tb_0123456789abcdef0123456789abcdef";
  let relay: FakeRelay;
  let server: StreamerServer;
  let configDir: string;
  let saved: string | undefined;

  beforeEach(async () => {
    saved = process.env.THREADBASE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "tb-rc-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
    relay = await new FakeRelay().start();
  });
  afterEach(async () => {
    await server.close();
    await relay.kill().catch(() => {});
    if (saved === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = saved;
    rmSync(configDir, { recursive: true, force: true });
  });

  async function boot(relayFlag: boolean): Promise<void> {
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      featureFlags: { relay: relayFlag },
      relayUrl: relay.url,
      relayPublicKey: relay.keyPair.publicKeyRaw.toString("base64url"),
    });
    await server.listen(0, { awaitReady: true });
  }

  const get = (path: string) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  const relayCheck = async () => {
    const report = (await (await get("/api/diagnostics")).json()) as {
      checks: { id: string; status: string; remediation: string }[];
    };
    return report.checks.find((c) => c.id === "relay");
  };

  it("does nothing while the flag is off", async () => {
    await boot(false);
    expect(await relayCheck()).toMatchObject({ status: "ok", remediation: "NONE" });
    expect(existsSync(join(configDir, "relay.sock"))).toBe(false);
    expect(relay.confirmedKeys).toEqual([]);
  });

  it("attaches under its identity key and opens the ingress listener", async () => {
    await boot(true);
    await waitFor(() => relay.confirmedKeys.length === 1);
    expect(relay.confirmedKeys[0]).toBe(loadOrCreateServerIdentity().publicKey);
    if (process.platform !== "win32") expect(existsSync(join(configDir, "relay.sock"))).toBe(true);
  });

  it("keeps serving direct requests when the relay dies", async () => {
    await boot(true);
    await waitFor(() => relay.confirmedKeys.length === 1);
    await relay.kill();
    expect((await get("/api/info")).status).toBe(200);
    expect(await relayCheck()).toMatchObject({
      status: "degraded",
      remediation: "RELAY_UNREACHABLE",
    });
  });
});
