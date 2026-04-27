import { createServer } from "http";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { StreamerServer } from "../src/server";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const API_KEY = "tb_test_key_for_pair_tests";

describe("Pair endpoints", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      publicUrl: "https://example.test",
    });
    await server.listen(port);
  });

  afterEach(async () => {
    await server.close();
  });

  describe("POST /api/pair/start", () => {
    it("requires auth", async () => {
      const res = await fetch(`${baseUrl}/api/pair/start`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("mints a token when authenticated", async () => {
      const res = await fetch(`${baseUrl}/api/pair/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        token: string;
        expiresAt: number;
        expiresInSeconds: number;
        publicUrl: string | null;
      };
      expect(body.token).toMatch(/^pt_[0-9a-f]{32}$/);
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      expect(body.expiresInSeconds).toBe(180);
      expect(body.publicUrl).toBe("https://example.test");
    });
  });

  describe("POST /api/pair/exchange", () => {
    async function mintToken(): Promise<string> {
      const r = await fetch(`${baseUrl}/api/pair/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const { token } = (await r.json()) as { token: string };
      return token;
    }

    it("does not require auth", async () => {
      const res = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "pt_nope", clientPublicKey: "x" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("rejects non-JSON content types", async () => {
      const res = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=pt_x&clientPublicKey=y",
      });
      expect(res.status).toBe(415);
    });

    it("rejects unknown tokens", async () => {
      const recipient = nacl.box.keyPair();
      const res = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "pt_unknown",
          clientPublicKey: naclUtil.encodeBase64(recipient.publicKey),
        }),
      });
      expect(res.status).toBe(401);
    });

    it("returns a sealed payload that decrypts to the api key", async () => {
      const token = await mintToken();
      const recipient = nacl.box.keyPair();

      const res = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          clientPublicKey: naclUtil.encodeBase64(recipient.publicKey),
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ciphertext: string;
        nonce: string;
        ephemeralPublicKey: string;
        publicUrl: string | null;
        machineName: string;
      };

      const plain = nacl.box.open(
        naclUtil.decodeBase64(body.ciphertext),
        naclUtil.decodeBase64(body.nonce),
        naclUtil.decodeBase64(body.ephemeralPublicKey),
        recipient.secretKey,
      );
      expect(plain).not.toBeNull();
      expect(naclUtil.encodeUTF8(plain!)).toBe(API_KEY);
      expect(body.publicUrl).toBe("https://example.test");
    });

    it("burns the token after a successful exchange", async () => {
      const token = await mintToken();
      const recipient = nacl.box.keyPair();
      const body = JSON.stringify({
        token,
        clientPublicKey: naclUtil.encodeBase64(recipient.publicKey),
      });

      const first = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(second.status).toBe(401);
    });

    it("rate-limits repeated attempts from the same IP", async () => {
      const recipient = nacl.box.keyPair();
      const body = JSON.stringify({
        token: "pt_unknown",
        clientPublicKey: naclUtil.encodeBase64(recipient.publicKey),
      });

      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const res = await fetch(`${baseUrl}/api/pair/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/info", () => {
    it("includes publicUrl", async () => {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = (await res.json()) as { publicUrl: string | null };
      expect(body.publicUrl).toBe("https://example.test");
    });
  });
});
