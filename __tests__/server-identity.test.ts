import { generateKeyPairSync } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";
import {
  loadOrCreateServerIdentity,
  serverIdentityKeyPath,
  serverIdentityPublicKey,
} from "../src/server-identity";

/**
 * The server identity key (E2EE phase 2 groundwork, #590).
 *
 * The property under test is not "a key came back" — an implementation that
 * mints a fresh key on every boot passes that, and would silently invalidate
 * every device that ever scanned a pair QR. What is asserted here is that the
 * key is the SAME one across calls and across server lifecycles, and that a
 * file which cannot be read fails loudly rather than regenerating.
 */

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

describe("server identity key", () => {
  const saved = process.env.THREADBASE_CONFIG_DIR;
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "threadbase-identity-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = saved;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("generates an X25519 key at ~/.threadbase/keys/server-identity.key", () => {
    const identity = loadOrCreateServerIdentity();

    expect(identity.publicKey).toMatch(B64URL_32);
    expect(Buffer.from(identity.publicKey, "base64url")).toHaveLength(32);
    expect(identity.privateKey.asymmetricKeyType).toBe("x25519");
    expect(serverIdentityKeyPath()).toBe(join(configDir, "keys", "server-identity.key"));
    expect(readFileSync(serverIdentityKeyPath(), "utf-8")).toBeTruthy();
  });

  // The file holds a private key, so the permission is the control. Skipped on
  // Windows, where the POSIX mode bits are not meaningful.
  it.skipIf(process.platform === "win32")("writes the key file 0600", () => {
    loadOrCreateServerIdentity();
    expect(statSync(serverIdentityKeyPath()).mode & 0o777).toBe(0o600);
  });

  // The regression this whole module exists to prevent: a second call must
  // return the first key and must not touch the file. Asserting the bytes are
  // unchanged is what catches an implementation that regenerates behind a cache
  // — the returned key would match while every restart re-paired the world.
  it("returns the same key on a second call and does not rewrite the file", () => {
    const first = loadOrCreateServerIdentity().publicKey;
    const onDisk = readFileSync(serverIdentityKeyPath(), "utf-8");

    const second = loadOrCreateServerIdentity().publicKey;

    expect(second).toBe(first);
    expect(readFileSync(serverIdentityKeyPath(), "utf-8")).toBe(onDisk);
  });

  it("loads a pre-existing key rather than generating one", () => {
    const { privateKey } = generateKeyPairSync("x25519");
    const jwk = privateKey.export({ format: "jwk" });
    writeKeyFile({ v: 1, createdAt: "2026-01-01T00:00:00.000Z", key: jwk });

    expect(serverIdentityPublicKey()).toBe(jwk.x);
  });

  // Regenerating on a bad read would be the silent version of losing the key.
  it("throws on an unreadable key file instead of minting a new one", () => {
    writeRawKeyFile("{ not json");

    expect(() => loadOrCreateServerIdentity()).toThrow(/could not be read/);
    expect(readFileSync(serverIdentityKeyPath(), "utf-8")).toBe("{ not json");
  });

  // JSON.parse quotes the offending input in its message, and the input here is
  // a private key. The thrown error is served to no one, but it is logged.
  it("never puts the file's contents in the error it throws", () => {
    writeRawKeyFile('{"d": "SUPER-SECRET-PRIVATE-KEY" ');

    const message = captureThrow(() => loadOrCreateServerIdentity());
    expect(message).toMatch(/could not be read/);
    expect(message).not.toContain("SUPER-SECRET-PRIVATE-KEY");
  });

  // Ed25519 imports fine and its JWK `x` is the same 43 characters, so without
  // the curve check the server would advertise a signing key as a DH key and
  // fail only later, inside a handshake.
  it("rejects a key file holding a different curve", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeKeyFile({
      v: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      key: privateKey.export({ format: "jwk" }),
    });

    expect(() => loadOrCreateServerIdentity()).toThrow(/not an X25519 key/);
  });

  function writeKeyFile(contents: unknown): void {
    writeRawKeyFile(JSON.stringify(contents));
  }

  function writeRawKeyFile(text: string): void {
    mkdirSync(join(configDir, "keys"), { recursive: true });
    writeFileSync(serverIdentityKeyPath(), text, "utf-8");
  }

  function captureThrow(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      return String(err);
    }
    throw new Error("expected the call to throw");
  }
});

describe("server identity key over HTTP", () => {
  const API_KEY = "tb_test_key_for_server_identity";
  const AUTH = { Authorization: `Bearer ${API_KEY}` };
  // Same host isolation server.test.ts uses: keep the scanner off the
  // developer's real ~/.codex and off the shared persistent index.
  const HOST_ISOLATION = { codexRoots: [] as string[], scannerPersistent: false };

  const saved = process.env.THREADBASE_CONFIG_DIR;
  let configDir: string;
  let cacheDir: string;
  const servers: StreamerServer[] = [];

  const boot = async (): Promise<string> => {
    const server = new StreamerServer({
      ...HOST_ISOLATION,
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
    });
    await server.listen(0, { awaitReady: true });
    servers.push(server);
    return `http://localhost:${server.port}`;
  };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "threadbase-identity-http-"));
    cacheDir = mkdtempSync(join(tmpdir(), "threadbase-identity-cache-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    if (saved === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = saved;
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("publishes the public key on /api/info and nothing else from the key file", async () => {
    const baseUrl = await boot();

    const raw = await (await fetch(`${baseUrl}/api/info`, { headers: AUTH })).text();
    const body = JSON.parse(raw) as { serverIdentityKey: string };

    expect(body.serverIdentityKey).toMatch(B64URL_32);
    expect(body.serverIdentityKey).toBe(loadOrCreateServerIdentity().publicKey);

    // The private key must never leave the process. `d` is the private scalar in
    // the stored JWK; the response must contain no part of it.
    const stored = JSON.parse(readFileSync(serverIdentityKeyPath(), "utf-8")) as {
      key: { d: string };
    };
    expect(stored.key.d).toBeTruthy();
    expect(raw).not.toContain(stored.key.d);
  });

  // The closest thing to a restart without a subprocess: two full server
  // lifecycles against one config dir. A key minted per boot fails here.
  it("serves the same key after a restart", async () => {
    const first = await (await fetch(`${await boot()}/api/info`, { headers: AUTH })).json();
    for (const server of servers.splice(0)) await server.close();

    const second = await (await fetch(`${await boot()}/api/info`, { headers: AUTH })).json();

    expect(second.serverIdentityKey).toBe(first.serverIdentityKey);
  });
});
