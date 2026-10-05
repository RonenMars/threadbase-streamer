import { createDecipheriv } from "crypto";
import { existsSync, mkdtempSync, rmSync } from "fs";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { generateKeyPair, type KeyPair, readMessage1, writeMessage2 } from "../src/e2ee/noise";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_UNSUPPORTED_PROTOCOL,
  RelayConnector,
  TUNNEL_PROLOGUE,
} from "../src/relay/connector";
import { StreamerServer } from "../src/server";
import { loadOrCreateServerIdentity } from "../src/server-identity";

/**
 * The streamer's half of the relay tunnel handshake, against a stand-in relay
 * built from the same Noise responder the relay uses. The confirmation check
 * below is the relay's, so a connector that sends anything else fails here.
 */

const CONFIRM = Buffer.from("threadbase-relay/1 confirm", "utf-8");

type Mode = "accept" | "unsupported";

class FakeRelay {
  wss!: WebSocketServer;
  port = 0;
  confirmedKeys: string[] = [];
  mode: Mode = "accept";
  constructor(readonly keyPair: KeyPair = generateKeyPair()) {}

  async start(port = 0): Promise<this> {
    this.wss = new WebSocketServer({ port, host: "127.0.0.1" });
    await new Promise((r) => this.wss.once("listening", r));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on("connection", (ws) => {
      let confirm: ((frame: Buffer) => void) | null = null;
      ws.on("message", (data: Buffer) => {
        if (confirm) return confirm(data);
        let state: ReturnType<typeof readMessage1>;
        try {
          state = readMessage1({
            staticKeyPair: this.keyPair,
            message1: data,
            pattern: "IK",
            prologue: TUNNEL_PROLOGUE,
          });
        } catch {
          return ws.close(CLOSE_AUTH_FAILED);
        }
        if (this.mode === "unsupported") return ws.close(CLOSE_UNSUPPORTED_PROTOCOL);
        const { message2, keys } = writeMessage2(state, Buffer.from("{}"));
        const { clientToServer, handshakeHash } = keys.consume();
        ws.send(message2);
        confirm = (frame) => {
          const d = createDecipheriv("chacha20-poly1305", clientToServer, Buffer.alloc(12), {
            authTagLength: 16,
          });
          d.setAAD(handshakeHash, { plaintextLength: CONFIRM.length });
          d.setAuthTag(frame.subarray(CONFIRM.length));
          const plain = Buffer.concat([d.update(frame.subarray(0, CONFIRM.length)), d.final()]);
          if (!plain.equals(CONFIRM)) return ws.close(CLOSE_AUTH_FAILED);
          this.confirmedKeys.push(state.initiatorStaticPub.toString("base64url"));
        };
      });
    });
    return this;
  }

  get url() {
    return `ws://127.0.0.1:${this.port}/tunnel`;
  }

  async kill(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise((r) => this.wss.close(r));
  }
}

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
