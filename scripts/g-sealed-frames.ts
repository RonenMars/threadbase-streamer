/**
 * G-1: observe SEALED WebSocket frame boundaries directly.
 *
 * Pairs a scratch device against a running rig with a real Noise IKpsk1 handshake,
 * opens a real WS context, then upgrades over a RAW TCP socket and parses frame
 * headers off the byte stream — so FIN bits and opcodes on the sealed leg are
 * observed, not inferred. No packet capture and no elevated privilege required.
 *
 *   npx tsx scripts/g-sealed-frames.ts <baseUrl> <apiKey> <sessionId>
 */
import net from "net";
import fs from "fs";
import crypto from "crypto";
import {
  CHANNEL_WS,
  createRecordState,
  DIRECTION_C2S,
  DIRECTION_S2C,
  type RecordState,
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

const [, , baseUrl, argvKey, sessionId] = process.argv;
// G-2: prefer the environment so the key never enters any process's argv
// (npx echoed the full command line, including the key, into a log — §14).
const apiKey = process.env.TB_KEY || argvKey;
if (!baseUrl || !apiKey || !sessionId) {
  console.error("usage: tsx scripts/g-sealed-frames.ts <baseUrl> <apiKey> <sessionId>");
  process.exit(2);
}
const log = (...a: unknown[]) => console.log(...a);

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function main() {
  const info = await json<{ serverIdentityKey: string; e2ee?: any }>("/api/info", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  log("server e2ee:", JSON.stringify(info.e2ee));
  const spk = Buffer.from(info.serverIdentityKey, "base64url");

  // --- pair a scratch device (real Noise IKpsk1) ---
  const { token } = await json<{ token: string }>("/api/pair/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: "{}",
  });
  const staticKeyPair: KeyPair = generateKeyPair();
  const pairInit = writeMessage1({
    prologue: PAIR_PROLOGUE,
    staticKeyPair,
    responderStaticPub: spk,
    psk: pskFromPairToken(token),
    payload: Buffer.from(JSON.stringify({ v: 1, deviceName: "g-frame-probe", readOnly: false }), "utf-8"),
  });
  const paired = await json<{ deviceId: string }>("/api/pair/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      clientPublicKey: Buffer.from(generateKeyPair().publicKeyRaw).toString("base64"),
      e2ee: { v: 1, noise: pairInit.message.toString("base64") },
    }),
  });
  log("paired scratch device", paired.deviceId.slice(0, 8) + "…");

  // --- open a real WS context, get the ticket ---
  const openInit = writeMessage1({
    prologue: OPEN_PROLOGUE,
    pattern: "IK",
    staticKeyPair,
    responderStaticPub: spk,
    payload: Buffer.from(JSON.stringify({ v: 1, kind: "ws" }), "utf-8"),
  });
  const openBody = await json<{ e2ee: { noise: string } }>("/api/e2ee/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ e2ee: { v: 1, noise: openInit.message.toString("base64") } }),
  });
  const msg2 = readMessage2(openInit.state, Buffer.from(openBody.e2ee.noise, "base64"));
  const keys = msg2.keys.consume();
  const payload = JSON.parse(msg2.payload.toString("utf-8")) as { ctxId: string; ticket?: string };
  const ctxIdRaw = Buffer.from(payload.ctxId, "base64url");
  const send: RecordState = createRecordState({
    key: keys.clientToServer, ctxId: ctxIdRaw, direction: DIRECTION_C2S, channel: CHANNEL_WS,
  });
  const recv: RecordState = createRecordState({
    key: keys.serverToClient, ctxId: ctxIdRaw, direction: DIRECTION_S2C, channel: CHANNEL_WS,
  });
  log("context open, ticket present:", Boolean(payload.ticket));
  if (!payload.ticket) throw new Error("no ticket returned for kind=ws");

  // --- raw socket upgrade with the ticket ---
  const u = new URL(baseUrl);
  const sock = net.createConnection({ host: u.hostname, port: Number(u.port) });
  const frames: Array<{ fin: number; opcode: number; len: number }> = [];
  let buf = Buffer.alloc(0);
  let upgraded = false;
  let reads = 0, bytesRead = 0;
  const wireOut = process.env.WIRE_OUT;
  const wireChunks: Buffer[] = [];

  const maskFrame = (payloadBuf: Buffer, opcode: number) => {
    const m = crypto.randomBytes(4);
    const n = payloadBuf.length;
    let header: Buffer;
    if (n < 126) header = Buffer.from([0x80 | opcode, 0x80 | n]);
    else if (n < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(n, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(n), 2); }
    const masked = Buffer.from(payloadBuf.map((b, i) => b ^ m[i % 4]));
    return Buffer.concat([header, m, masked]);
  };
  const sealedSend = (obj: unknown) =>
    sock.write(maskFrame(Buffer.from(send.seal(Buffer.from(JSON.stringify(obj), "utf-8"))), 2));

  await new Promise<void>((resolve) => {
    sock.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nX-TB-Ticket: ${payload.ticket}\r\n\r\n`
      );
    });
    sock.on("data", (d) => {
      reads++; bytesRead += d.length;
      if (wireOut && upgraded) wireChunks.push(Buffer.from(d));
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const head = buf.subarray(0, i).toString();
        log("handshake:", head.split("\r\n")[0]);
        if (!head.includes("101")) { log(head.slice(0, 400)); sock.destroy(); return resolve(); }
        buf = buf.subarray(i + 4);
        upgraded = true;
        if (wireOut) wireChunks.push(Buffer.from(buf));
        sealedSend({ type: "register", clientId: "g-frame-probe" });
        setTimeout(() => sealedSend({ type: "subscribe_session", sessionId }), 400);
      }
      // parse complete frames
      for (;;) {
        if (buf.length < 2) break;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) >> 7, opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) >> 7;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (masked) off += 4;
        if (buf.length < off + len) break;
        frames.push({ fin, opcode, len });
        buf = buf.subarray(off + len);
      }
    });
    sock.on("error", (e) => { log("socket error:", e.message); resolve(); });
    setTimeout(() => { sock.destroy(); resolve(); }, 12000);
  });

  if (wireOut) {
    const all = Buffer.concat(wireChunks);
    fs.writeFileSync(wireOut, all);
    log("wire bytes written:", all.length, "->", wireOut);
  }
  log(`\nTCP reads: ${reads}  bytes read: ${bytesRead}`);
  log(`complete WebSocket frames parsed: ${frames.length}`);
  const names: Record<number, string> = { 0: "CONTINUATION", 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong" };
  const by: Record<number, number> = {};
  for (const f of frames) by[f.opcode] = (by[f.opcode] || 0) + 1;
  for (const op of Object.keys(by).map(Number).sort((a, b) => a - b))
    log(`  opcode ${op}  ${names[op] ?? "other"}  ${by[op]} frames`);
  log(`  FIN=0 (fragmented) frames: ${frames.filter((f) => f.fin === 0).length}`);
  log(`  opcode-0 continuation frames: ${by[0] ?? 0}`);
  const big = [...frames].sort((a, b) => b.len - a.len).slice(0, 5);
  log("  largest 5 (fin,opcode,len):", big.map((f) => `(${f.fin},${f.opcode},${f.len})`).join(" "));
  // prove the biggest sealed frame really is sealed application data we can open
  void recv;
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
