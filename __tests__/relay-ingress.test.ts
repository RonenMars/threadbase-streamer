import { mkdtempSync, rmSync } from "fs";
import { createServer, request as httpRequest, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as miscRoutes from "../src/api/routes/misc.routes";
import { generateKeyPair, PAIR_PROLOGUE, pskFromPairToken, writeMessage1 } from "../src/e2ee/noise";
import { isViaRelay, listenRelayIngress } from "../src/relay/ingress";
import { StreamerServer } from "../src/server";
import { loadOrCreateServerIdentity } from "../src/server-identity";

/**
 * The relay ingress listener closes every loopback carve-out.
 *
 * A relay is an untrusted transport, and a connector forwarding its streams to
 * the TCP port would arrive from 127.0.0.1 and be treated as the machine's
 * owner. The second listener exists so that cannot happen, and each test here
 * sends ONE request down both listeners: the TCP answer is the positive control
 * that the carve-out is real, the relay answer is the refusal. A refusal with
 * no control would also pass against a server that refuses everything.
 */

const API_KEY = "tb_0123456789abcdef0123456789abcdef";

// Named pipes are not files; a unix socket path must stay short (sun_path).
const ingressPath = (dir: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\tb-relay-test-${process.pid}-${Date.now()}`
    : join(dir, "relay.sock");

type Answer = { status: number; body: any };

function call(
  target: { socketPath: string } | { port: number },
  args: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = args.body === undefined ? undefined : JSON.stringify(args.body);
    const req = httpRequest(
      {
        ...("port" in target ? { host: "127.0.0.1", port: target.port } : target),
        method: args.method ?? "GET",
        path: args.path,
        headers: {
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...args.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("listenRelayIngress", () => {
  let dir: string;
  let http: Server;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-ri-"));
  });
  afterEach(() => {
    http.closeAllConnections();
    http.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tags its own connections, and only those", async () => {
    http = createServer((req, res) => {
      res.end(
        JSON.stringify({
          viaRelay: isViaRelay(req.socket),
          remoteAddress: req.socket.remoteAddress ?? null,
        }),
      );
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const path = ingressPath(dir);
    const ingress = await listenRelayIngress(http, path);

    const tcp = await call({ port: (http.address() as { port: number }).port }, { path: "/" });
    const relay = await call({ socketPath: path }, { path: "/" });
    ingress.close();

    expect(tcp.body).toEqual({ viaRelay: false, remoteAddress: "127.0.0.1" });
    // No address at all — so `isLocalRequest` could never have matched it, but
    // the gate does not rest on that.
    expect(relay.body).toEqual({ viaRelay: true, remoteAddress: null });
  });

  it("replaces a stale socket file left by a crashed process", async () => {
    if (process.platform === "win32") return;
    http = createServer((_req, res) => res.end("ok"));
    const path = ingressPath(dir);
    const first = await listenRelayIngress(http, path);
    // `first` is still listening, so its socket file is on disk exactly as a
    // crashed process would have left it.
    const second = await listenRelayIngress(http, path);
    expect((await call({ socketPath: path }, { path: "/" })).body).toBe("ok");
    first.close();
    second.close();
  });
});

describe("requests accepted on the relay ingress listener", () => {
  let server: StreamerServer;
  let configDir: string;
  let savedConfigDir: string | undefined;
  let tcp: { port: number };
  let relay: { socketPath: string };

  async function boot(localNoAuth: boolean): Promise<void> {
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth,
      verbose: false,
      relayIngressPath: relay.socketPath,
    });
    await server.listen(0, { awaitReady: true });
    tcp = { port: server.port };
  }

  beforeEach(() => {
    savedConfigDir = process.env.THREADBASE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "tb-ri-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
    relay = { socketPath: ingressPath(configDir) };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    if (savedConfigDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = savedConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("refuses an unauthenticated /healthz", async () => {
    await boot(false);
    expect((await call(tcp, { path: "/healthz" })).status).toBe(200);
    expect((await call(relay, { path: "/healthz" })).status).toBe(401);
  });

  it("refuses the localhost-only log routes", async () => {
    await boot(false);
    for (const path of ["/api/logs", "/api/logs/meta"]) {
      expect((await call(tcp, { path })).status).not.toBe(401);
      expect((await call(relay, { path })).status).toBe(401);
    }
  });

  it("gives --local-no-auth nothing", async () => {
    await boot(true);
    expect((await call(tcp, { path: "/api/info" })).status).toBe(200);
    expect((await call(relay, { path: "/api/info" })).status).toBe(401);
  });

  it("refuses a valid API key, as a Bearer or as ?key=", async () => {
    await boot(false);
    const bearer = { path: "/api/info", headers: { Authorization: `Bearer ${API_KEY}` } };
    const query = { path: `/api/info?key=${API_KEY}` };
    for (const req of [bearer, query]) {
      expect((await call(tcp, req)).status).toBe(200);
      const refused = await call(relay, req);
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe("RELAY_PLAINTEXT_CREDENTIAL");
    }
  });

  it("does not offer the HMAC-gated public POST paths", async () => {
    await boot(false);
    for (const path of ["/api/__update", "/internal/sessions/abc/progress"]) {
      expect((await call(tcp, { method: "POST", path, body: {} })).status).not.toBe(401);
      expect((await call(relay, { method: "POST", path, body: {} })).status).toBe(401);
    }
  });

  describe("pairing", () => {
    async function mintToken(): Promise<string> {
      const r = await call(tcp, {
        method: "POST",
        path: "/api/pair/start",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      return r.body.token;
    }
    const legacy = (token: string) => ({
      method: "POST",
      path: "/api/pair/exchange",
      body: { token, clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey) },
    });

    beforeEach(async () => {
      await boot(false);
      vi.spyOn(miscRoutes, "describeE2eeCapability").mockReturnValue({
        supported: true,
        enabled: true,
        version: 1,
        required: false,
      });
    });

    it("refuses legacy pairing, without spending the token", async () => {
      const token = await mintToken();
      const refused = await call(relay, legacy(token));
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("RELAY_E2EE_REQUIRED");
      // The control, and the proof the refusal left the token alone.
      expect((await call(tcp, legacy(token))).status).toBe(200);
    });

    it("refuses legacy pairing when this build has E2EE off", async () => {
      vi.restoreAllMocks();
      const refused = await call(relay, legacy(await mintToken()));
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("RELAY_E2EE_REQUIRED");
    });

    it("completes a Noise pairing", async () => {
      const token = await mintToken();
      const initiator = writeMessage1({
        prologue: PAIR_PROLOGUE,
        staticKeyPair: generateKeyPair(),
        responderStaticPub: Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url"),
        psk: pskFromPairToken(token),
        payload: Buffer.from(
          JSON.stringify({ v: 1, deviceName: "relay test", readOnly: false }),
          "utf-8",
        ),
      });
      const paired = await call(relay, {
        ...legacy(token),
        body: {
          ...legacy(token).body,
          e2ee: { v: 1, noise: initiator.message.toString("base64") },
        },
      });
      expect(paired.status).toBe(200);
      expect(typeof paired.body.e2ee?.noise).toBe("string");
    });
  });
});
