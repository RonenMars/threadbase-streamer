/**
 * D2 timing measurements against a LIVE streamer.
 *
 * Not a test — a measuring instrument. It pairs a scratch device against a
 * running rig, opens real contexts, and times what the server actually does,
 * because the constants are only claims until something observes them.
 *
 *   npx tsx scripts/d2-timings.ts <baseUrl> <apiKey>
 *
 * Measures:
 *   1. WS first-sealed-frame deadline — spend a ticket, upgrade, send nothing,
 *      and time the close. Positive control: a socket that DOES send a valid
 *      first frame must still be alive well past that deadline.
 *   2. REST provisional TTL — open a REST context, use it immediately (proving
 *      it works), then leave it unused past the ticket TTL and see what a later
 *      request gets.
 *
 * Leaves one paired device row behind; delete it afterwards or use a scratch rig.
 */
import WebSocket from "ws";
import {
  CHANNEL_REST_REQUEST,
  CHANNEL_WS,
  createRecordState,
  DIRECTION_C2S,
  DIRECTION_S2C,
  type RecordState,
  restTargetHash,
} from "../src/e2ee/record";
import {
  generateKeyPair,
  type KeyPair,
  OPEN_PROLOGUE,
  PAIR_PROLOGUE,
  pskFromPairToken,
  readMessage2,
  writeMessage1,
} from "../src/e2ee/noise";

const [, , baseUrl, apiKey] = process.argv;
if (!baseUrl || !apiKey) {
  console.error("usage: tsx scripts/d2-timings.ts <baseUrl> <apiKey>");
  process.exit(2);
}

const log = (...a: unknown[]) => console.log(...a);
const ms = (start: number) => `${Date.now() - start} ms`;

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

async function serverStaticPub(): Promise<Buffer> {
  const info = await json<{ serverIdentityKey: string }>("/api/info", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return Buffer.from(info.serverIdentityKey, "base64url");
}

/** Pair a scratch device: real Noise IKpsk1 over the real public endpoint. */
async function pair(spk: Buffer): Promise<{ deviceToken: string; staticKeyPair: KeyPair }> {
  const { token } = await json<{ token: string }>("/api/pair/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: "{}",
  });
  const staticKeyPair = generateKeyPair();
  const initiator = writeMessage1({
    prologue: PAIR_PROLOGUE,
    staticKeyPair,
    responderStaticPub: spk,
    psk: pskFromPairToken(token),
    payload: Buffer.from(JSON.stringify({ v: 1, deviceName: "d2-timing-probe", readOnly: false }), "utf-8"),
  });
  const body = await json<{ deviceId: string; deviceToken: string }>("/api/pair/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      clientPublicKey: Buffer.from(generateKeyPair().publicKeyRaw).toString("base64"),
      e2ee: { v: 1, noise: initiator.message.toString("base64") },
    }),
  });
  log(`  paired scratch device ${body.deviceId.slice(0, 8)}…`);
  return { deviceToken: body.deviceToken, staticKeyPair };
}

/** One real transport handshake. Returns the context the server just minted. */
async function openContext(
  spk: Buffer,
  staticKeyPair: KeyPair,
  kind: "ws" | "rest",
): Promise<{ ctxId: string; ticket?: string; send: RecordState; recv: RecordState }> {
  const initiator = writeMessage1({
    prologue: OPEN_PROLOGUE,
    pattern: "IK",
    staticKeyPair,
    responderStaticPub: spk,
    payload: Buffer.from(JSON.stringify({ v: 1, kind }), "utf-8"),
  });
  const body = await json<{ e2ee: { noise: string } }>("/api/e2ee/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ e2ee: { v: 1, noise: initiator.message.toString("base64") } }),
  });
  const msg2 = readMessage2(initiator.state, Buffer.from(body.e2ee.noise, "base64"));
  const keys = msg2.keys.consume();
  const payload = JSON.parse(msg2.payload.toString("utf-8")) as {
    ctxId: string;
    ticket?: string;
    expiresAt: number;
    provisional: boolean;
  };
  const channel = kind === "ws" ? CHANNEL_WS : CHANNEL_REST_REQUEST;
  // The wire carries `ctxId` base64url-encoded; the record header wants the raw
  // 16 bytes. Encoding it twice is the trap `record.ts` §4 warns about.
  const ctxIdRaw = Buffer.from(payload.ctxId, "base64url");
  return {
    ctxId: payload.ctxId,
    ticket: payload.ticket,
    // Client seals with direction 1 and opens direction 2, mirroring the server.
    send: createRecordState({ key: keys.clientToServer, ctxId: ctxIdRaw, direction: DIRECTION_C2S, channel }),
    recv: createRecordState({ key: keys.serverToClient, ctxId: ctxIdRaw, direction: DIRECTION_S2C, channel }),
  };
}

/** Upgrade with a ticket, optionally send a valid first frame, and time the close. */
function timeSocket(ticket: string, firstFrame: Buffer | null): Promise<number | "survived"> {
  return new Promise((resolve) => {
    const started = Date.now();
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`, {
      headers: { "X-TB-Ticket": ticket },
    });
    const ceiling = setTimeout(() => {
      ws.close();
      resolve("survived");
    }, 25_000);
    ws.on("open", () => {
      if (firstFrame) ws.send(firstFrame);
    });
    ws.on("close", () => {
      clearTimeout(ceiling);
      resolve(Date.now() - started);
    });
    ws.on("error", () => {
      /* close follows */
    });
  });
}

async function main() {
  const spk = await serverStaticPub();
  const { staticKeyPair } = await pair(spk);

  log("\n[1] WS first-sealed-frame deadline");
  const silent = await openContext(spk, staticKeyPair, "ws");
  const t0 = Date.now();
  const silentClose = await timeSocket(silent.ticket ?? "", null);
  log(`  silent socket (never sends a frame): closed after ${silentClose} — wall ${ms(t0)}`);

  const talker = await openContext(spk, staticKeyPair, "ws");
  const frame = talker.send.seal(
    Buffer.from(JSON.stringify({ type: "subscribe_session", sessionId: "d2-timing" }), "utf-8"),
  );
  const t1 = Date.now();
  const talkerClose = await timeSocket(talker.ticket ?? "", Buffer.from(frame));
  log(`  POSITIVE CONTROL, sends a valid first frame: ${talkerClose} — wall ${ms(t1)}`);

  log("\n[2] REST context lifetime — how long does a context answer?");
  const rest = await openContext(spk, staticKeyPair, "rest");
  const openedAt = Date.now();

  /** One sealed GET. The sequence header must equal the frame's own counter. */
  const sealedGet = async (ctx: { ctxId: string; send: RecordState }) => {
    const target = restTargetHash("GET", "/api/profiles", "");
    const frame = ctx.send.seal(Buffer.alloc(0), target);
    const res = await fetch(`${baseUrl}/api/profiles`, {
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        // header: version(1) || ctxId(16) || direction(4) || counter(8) || channel(1)
        "X-TB-Seq": String(Buffer.from(frame).readBigUInt64BE(21)),
        "X-TB-Env": Buffer.from(frame).toString("base64url"),
      },
    });
    const code = res.headers.get("x-tb-e2ee") ? "sealed" : await res.text().catch(() => "");
    return { status: res.status, code: String(code).slice(0, 90) };
  };

  // A SECOND context, opened now and deliberately never used, so its
  // provisional deadline can be observed separately from the one below.
  const unused = await openContext(spk, staticKeyPair, "rest");
  const unusedOpenedAt = Date.now();

  const immediate = await sealedGet(rest);
  log(`  t+${Date.now() - openedAt} ms  used context, first sealed request: ${immediate.status} ${immediate.code}`);

  // The context is PROVISIONAL until something authenticates under it, and a
  // provisional context dies at the ticket TTL (30 s), not at the 24 h REST
  // lifetime its expiry advertises. This is the boundary worth timing.
  for (const waitTo of [20_000, 35_000]) {
    const delay = waitTo - (Date.now() - openedAt);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const probe = await sealedGet(rest);
    log(`  t+${Date.now() - openedAt} ms  used context, sealed request: ${probe.status} ${probe.code}`);
  }

  const neverUsed = await sealedGet(unused);
  log(
    `  t+${Date.now() - unusedOpenedAt} ms  NEVER-USED context, first request: ${neverUsed.status} ${neverUsed.code}`,
  );
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
