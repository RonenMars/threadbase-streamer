import { createServer } from "http";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { PairTokenStore } from "../src/pair-store";
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
      // Public endpoint: any 401 must come from the handler (e.g. unknown
      // token), never from the auth gate. The gate's 401 carries error="Unauthorized".
      if (res.status === 401) {
        const body = (await res.json()) as { error?: string };
        expect(body.error).not.toBe("Unauthorized");
      }
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
      expect(naclUtil.encodeUTF8(plain as Uint8Array)).toBe(API_KEY);
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

    /**
     * A pair token must survive a request that fails on the client's own input.
     *
     * It used to be consumed before anything validated the rest of the body, so
     * a malformed `clientPublicKey` spent the token and the user's retry got
     * `401 Pair token used` — the exact response design.md §2.6 designates as
     * QR-replay detection. A signal with a common benign cause is a signal
     * nobody acts on, so this is a security property rather than a convenience.
     */
    it("keeps the token spendable when the exchange fails on a bad client key", async () => {
      const token = await mintToken();

      const rejected = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Well-formed base64, wrong length — reaches `seal` and throws there,
        // which is the failure that used to burn the token.
        body: JSON.stringify({ token, clientPublicKey: naclUtil.encodeBase64(new Uint8Array(8)) }),
      });
      expect(rejected.status).toBe(400);

      const recipient = nacl.box.keyPair();
      const retried = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          clientPublicKey: naclUtil.encodeBase64(recipient.publicKey),
        }),
      });
      expect(retried.status).toBe(200);
    });

    // The other half of the same property: surviving a failure must not make
    // the token reusable after it has actually been spent.
    it("still burns the token once the exchange succeeds", async () => {
      const token = await mintToken();
      const good = JSON.stringify({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
      });

      await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, clientPublicKey: naclUtil.encodeBase64(new Uint8Array(8)) }),
      });
      const first = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: good,
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: good,
      });
      expect(second.status).toBe(401);
      expect(((await second.json()) as { error?: string }).error).toContain("used");
    });

    /**
     * The single-use guarantee rests on nothing yielding between the check and
     * the spend — so prove that, rather than asserting it in a comment.
     *
     * `wouldConsume` queues a microtask that sets a flag. If the handler runs
     * straight through to `consume`, that microtask cannot have run yet and the
     * flag is still false. Any yield in the gap flips it, because suspending on
     * an `await` drains the microtask queue first — so this catches a macrotask
     * yield (I/O, a timer) and a microtask-only one alike.
     *
     * The microtask-only case is the one worth having, and it is not the
     * obvious `await Promise.resolve()`. It is an `await cache.get(...)` that
     * hits and returns an already-resolved promise: harmless in review,
     * exploitable by nothing today, and it falsifies the comment above
     * `consume` — which claims *nothing* yields, without qualification.
     * A test that only caught macrotasks would protect the exploitability
     * argument rather than the invariant, and the two have already drifted
     * apart once. Today's non-exploitability rests on every path reaching here
     * through `readBody`'s socket I/O, which is a fact about the current call
     * graph rather than a structural guarantee.
     */
    it("does not yield between checking the token and spending it", async () => {
      let drained = false;
      let observed = 0;

      const store = PairTokenStore.prototype;
      const realWould = store.wouldConsume;
      const realConsume = store.consume;
      store.wouldConsume = function (t: string) {
        observed++;
        Promise.resolve().then(() => {
          drained = true;
        });
        return realWould.call(this, t);
      };
      store.consume = function (t: string) {
        observed++;
        // Read at the moment of the spend, not after the request settles —
        // by then the microtask has long since run for ordinary reasons.
        expect(drained).toBe(false);
        return realConsume.call(this, t);
      };

      try {
        const token = await mintToken();
        const res = await fetch(`${baseUrl}/api/pair/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
          }),
        });
        expect(res.status).toBe(200);
      } finally {
        store.wouldConsume = realWould;
        store.consume = realConsume;
      }

      // Both patches ran, so the assertion inside `consume` was actually
      // reached. Without this the test passes when neither is ever called.
      expect(observed).toBe(2);
    });

    // An unknown token is refused before any cryptography runs, which is what
    // makes consuming late safe: reaching `seal` at all requires the real token.
    it("refuses an unknown token without reporting a key problem", async () => {
      const res = await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A key that WOULD fail in `seal`, paired with a token that never
        // reaches it. The 401 proves the order.
        body: JSON.stringify({
          token: "pt_unknown",
          clientPublicKey: naclUtil.encodeBase64(new Uint8Array(8)),
        }),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error?: string }).error).toContain("unknown");
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
