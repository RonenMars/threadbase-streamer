// The streamer's long-term X25519 identity key.
//
// It exists so a client can tell WHICH server answered its pair exchange. Today
// the QR carries no server key material, so the phone opens the sealed box with
// whatever `ephemeralPublicKey` came back (src/seal.ts) — a man in the middle
// answers just as convincingly as the real server. Putting the public half in
// the QR makes the printed code an out-of-band channel for the server's
// identity, which is what the Noise `IK` handshake later builds on
// (specs/end-to-end-encryption/design.md §2.2, §2.3).
//
// This module is only the identity half. Nothing here encrypts anything and no
// handshake uses the key yet. That scoping is deliberate: publishing a public
// key is additive and cannot break a released client.

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { getLogger } from "./logger";

/**
 * On-disk format version.
 *
 * Rotation is out of scope, but the version is the difference between rotating
 * later and re-pairing every device: a future file holding a key *set* can be
 * told apart from this one holding a single key, without guessing from shape.
 */
const IDENTITY_FILE_VERSION = 1;

interface IdentityFile {
  v: number;
  createdAt: string;
  key: JsonWebKey;
}

export interface ServerIdentity {
  /** Raw X25519 public key, base64url, 43 chars. Public: the QR, /api/info, logs. */
  publicKey: string;
  /** Never leaves the process — not a log line, not a response, not an error message. */
  privateKey: KeyObject;
}

/**
 * `~/.threadbase/keys/server-identity.key`.
 *
 * Its own file, not a `server.yaml` key: that file is parsed by single-line
 * regex and users are invited to hand-edit it, which is no place for a private
 * key. The config dir is resolved per call, and inlined rather than imported
 * from auth.ts, matching runtime-store.ts / pty-host/socket.ts /
 * codexGateAnswers.ts — tests redirect it with THREADBASE_CONFIG_DIR.
 */
export function serverIdentityKeyPath(): string {
  const dir = process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase");
  return join(dir, "keys", "server-identity.key");
}

/**
 * The server identity, generated on first call and stable forever after —
 * across restarts and across API-key rotation.
 *
 * Stability is the whole point. The public half goes into a pair QR, so minting
 * a second key would silently invalidate every device that scanned the first.
 * A file that exists but cannot be read therefore **throws** rather than
 * regenerating: losing this key must be a deliberate act (delete the file), not
 * the recovery path for a bad read.
 */
export function loadOrCreateServerIdentity(): ServerIdentity {
  const path = serverIdentityKeyPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return generateIdentity(path);
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: (JSON.parse(raw) as IdentityFile).key, format: "jwk" });
  } catch {
    // The caught error is deliberately dropped rather than interpolated: a
    // JSON.parse failure quotes the offending input, and this file's input is a
    // private key. The path is enough to act on.
    throw new Error(
      `Server identity key at ${path} could not be read. Refusing to generate a new one — ` +
        "that would invalidate every paired device. Repair or delete the file deliberately.",
    );
  }
  return { publicKey: publicKeyOf(privateKey), privateKey };
}

/** The public half alone, for callers that must never hold the private key. */
export function serverIdentityPublicKey(): string {
  return loadOrCreateServerIdentity().publicKey;
}

function generateIdentity(path: string): ServerIdentity {
  const { privateKey } = generateKeyPairSync("x25519");
  const file: IdentityFile = {
    v: IDENTITY_FILE_VERSION,
    createdAt: new Date().toISOString(),
    key: privateKey.export({ format: "jwk" }),
  };

  // tmp-then-rename at 0600 — the discipline setConfigValue already uses for
  // server.yaml (src/auth.ts). writeFileSync's mode only applies when it
  // creates the file and is masked by the umask, so the chmod is what makes the
  // permission unconditional.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);

  const publicKey = publicKeyOf(privateKey);
  // The public key is logged on purpose: it is printable by design, and a boot
  // line is the out-of-band record a user can compare a QR against.
  getLogger("identity").info(`Generated server identity key ${publicKey}`, {
    event: "identity.key_generated",
    path,
  });
  return { publicKey, privateKey };
}

/**
 * Derived from the private key rather than read from the file's own `x`, so a
 * file whose public half was edited can never make the server advertise a key
 * it cannot prove possession of.
 */
function publicKeyOf(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  // Guards a file holding some other OKP curve (Ed25519 imports fine and its
  // `x` is the same 43 characters), which would be published as an X25519 key
  // and fail only later, inside a handshake.
  if (jwk.crv !== "X25519" || typeof jwk.x !== "string") {
    throw new Error(`Server identity key at ${serverIdentityKeyPath()} is not an X25519 key`);
  }
  return jwk.x; // JWK OKP `x` is already base64url of the raw 32 bytes
}
