import { createServer } from "http";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The QR-replay signal, as something an operator can actually see (#609).
 *
 * design.md §2.6 names a second exchange with an already-spent token as the
 * detection signal for a photographed QR: someone copied the code and paired
 * before the legitimate phone did. Until now that reached the client as a bare
 * 401 and reached the operator's log as **silence** — and the operator is the
 * one who can act on it, because the user whose pairing failed is not reading
 * HTTP status codes.
 *
 * Its own file because the logger mock is module-scoped and the rest of the
 * pairing tests should keep exercising the real one.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any) =>
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

const API_KEY = "tb_test_key_for_replay_log";
const replays = () => h.calls.filter((c) => c.fields?.event === "pair.token_replayed");

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

describe("a replayed pair token", () => {
  let server: InstanceType<typeof StreamerServer>;
  let baseUrl: string;

  beforeEach(async () => {
    h.calls.length = 0;
    const port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;
    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
    });
    await server.listen(port);
  });

  afterEach(async () => {
    await server.close();
  });

  const exchange = (token: string) =>
    fetch(`${baseUrl}/api/pair/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
      }),
    });

  async function mintToken(): Promise<string> {
    const r = await fetch(`${baseUrl}/api/pair/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    return ((await r.json()) as { token: string }).token;
  }

  it("warns, with something an operator can act on", async () => {
    const token = await mintToken();
    expect((await exchange(token)).status).toBe(200);
    // Nothing to report yet: one pairing is not a replay.
    expect(replays()).toHaveLength(0);

    expect((await exchange(token)).status).toBe(401);

    const warned = replays();
    expect(warned).toHaveLength(1);
    expect(warned[0].level).toBe("warn");
    // Says what to do, not just that something happened. A line reading
    // "pair token used" would be a restatement of the status code.
    expect(warned[0].msg).toMatch(/revoke/i);
    expect(warned[0].fields.ip).toBeDefined();
  });

  /**
   * The token is live credential material until it expires — anyone reading the
   * log could pair with it. Logging the thing that was replayed is the obvious
   * instinct and the wrong one.
   */
  it("never writes the token into the log", async () => {
    const token = await mintToken();
    await exchange(token);
    await exchange(token);

    expect(replays()).toHaveLength(1);
    expect(JSON.stringify(h.calls)).not.toContain(token);
  });

  // The other two refusal reasons are ordinary. An expired or unknown token is
  // a user who waited too long or mistyped something, and warning on those
  // would bury the one line that means a device may have been stolen.
  it("stays quiet for an unknown token", async () => {
    expect((await exchange("pt_00000000000000000000000000000000")).status).toBe(401);
    expect(replays()).toHaveLength(0);
  });
});
