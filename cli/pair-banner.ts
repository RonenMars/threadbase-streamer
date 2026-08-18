import qrcode from "qrcode-terminal";
import type { E2eeCapability } from "../src/api/routes/misc.routes";
import { resolveServerUrl } from "../src/lan-url";
import { getLogger } from "../src/logger";
import { serverIdentityPublicKey } from "../src/server-identity";

const cliLog = getLogger("cli");

export interface PairBannerLog {
  /** Banner lines, always through the console dest — this is user-facing output. */
  info: (msg: string) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface PairBannerDeps {
  /** Overridable for tests; defaults to the real console-dest logger. */
  log?: PairBannerLog;
  /** Overridable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Overridable for tests; defaults to the real on-disk identity key. */
  identityKey?: () => string;
}

const defaultLog: PairBannerLog = {
  info: (msg) => cliLog.info(msg, undefined, "console"),
  warn: (msg, meta) => cliLog.warn(msg, meta),
};

function generateQr(payload: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(payload, { small: true }, resolve);
  });
}

export function printUrlBanner({
  url,
  qr,
  expiresAt,
}: {
  url: string;
  qr?: string;
  expiresAt?: number;
}): string {
  const contentLines = ["Threadbase Streamer — server address", "", url];
  if (qr) {
    contentLines.push("", ...qr.split("\n").filter((l) => l.length > 0));
    if (expiresAt !== undefined) {
      contentLines.push(
        "",
        `Scan to pair a mobile client (expires ${new Date(expiresAt).toLocaleTimeString()})`,
      );
    } else {
      contentLines.push("", "Scan to pair a mobile client");
    }
  }

  const width = Math.max(...contentLines.map((l) => l.length));
  const pad = (l: string) => `║ ${l}${" ".repeat(width - l.length)} ║`;
  const top = `╔${"═".repeat(width + 2)}╗`;
  const bottom = `╚${"═".repeat(width + 2)}╝`;

  return `\n${top}\n${contentLines.map(pad).join("\n")}\n${bottom}\n`;
}

/**
 * Whether the server that will handle `POST /api/pair/exchange` actually
 * accepts a handshake — asked of that server, not computed here.
 *
 * The two can disagree. `tb-streamer pair` prints a QR for a daemon that is
 * already running and may be a different build from this CLI, and the `e2ee`
 * feature flag resolves inside that daemon at its boot, from an argv a fixed
 * launchd plist or Task Scheduler action supplies and this process never sees.
 * The capability that matters belongs to the process that answers the exchange.
 *
 * `GET /api/info` returns `describeE2eeCapability(...)` verbatim, so this reads
 * that one answer rather than restating it — there is no second constant here
 * to drift from `E2EE_SUPPORTED`.
 *
 * Every failure resolves to false: an older server with no `e2ee` field (absent
 * means "unknown", and a server too old to answer is too old to have the
 * handshake), an unreachable endpoint, an unreadable body. That degrade is safe
 * in one direction only — a QR without `spk` always pairs through the legacy
 * path, whereas an `spk` the exchange then refuses is exactly the dishonest
 * advertisement the QR-carried capability exists to prevent (design.md §2.3).
 */
async function exchangeAcceptsE2ee({
  fetchFn,
  port,
  apiKey,
  log,
}: {
  fetchFn: typeof globalThis.fetch;
  port: number;
  apiKey: string;
  log: PairBannerLog;
}): Promise<boolean> {
  try {
    const res = await fetchFn(`http://localhost:${port}/api/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      log.warn(`(pairing QR omits the encryption offer: /api/info returned ${res.status})`, {
        event: "pair.e2ee_capability_unknown",
        status: res.status,
      });
      return false;
    }
    const info = (await res.json()) as { e2ee?: Partial<E2eeCapability> };
    return info.e2ee?.enabled === true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`(pairing QR omits the encryption offer: ${message})`, {
      event: "pair.e2ee_capability_unknown",
      reason: message,
    });
    return false;
  }
}

export async function printServerBanner(
  {
    port,
    apiKey,
    publicUrl,
    includeQr,
  }: {
    port: number;
    apiKey: string;
    publicUrl: string | null;
    includeQr: boolean;
  },
  deps: PairBannerDeps = {},
): Promise<void> {
  const log = deps.log ?? defaultLog;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const identityKey = deps.identityKey ?? serverIdentityPublicKey;
  const url = resolveServerUrl({ publicUrl, port });

  if (!includeQr) {
    log.info(printUrlBanner({ url }));
    return;
  }

  const e2eeOffered = await exchangeAcceptsE2ee({ fetchFn, port, apiKey, log });

  const res = await fetchFn(`http://localhost:${port}/api/pair/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`/api/pair/start returned ${res.status}`);
  }
  const { token, expiresAt, expiresInSeconds } = (await res.json()) as {
    token: string;
    expiresAt: number;
    expiresInSeconds: number;
  };

  const expSeconds = Math.floor(expiresAt / 1000);
  // `spk` is this server's identity public key (src/server-identity.ts): 43
  // base64url characters, so URL-safe unencoded. `v` is the envelope version,
  // per design §2.3.
  //
  // Both are emitted ONLY while the exchange will accept a handshake, because
  // this QR is the client's only pairing-time capability signal: `GET /api/info`
  // is authenticated and pairing is the request that mints the credential. That
  // is what makes the client's gate honest — a valid `spk` means "this server
  // will accept msg1", so an absent msg2 afterwards is a refusal rather than a
  // capability answer arriving late.
  //
  // A disabled build prints neither, which is byte-identical to the QR it
  // printed before any of this existed. Additive either way: parsePairUri on
  // the client reads named parameters and ignores the rest, so an older app
  // scanning either QR behaves exactly as it does today.
  //
  // `identityKey()` is only called on the enabled path — a corrupt key file
  // costs the QR on a build that would have used it, and costs nothing on one
  // that would not.
  const payload =
    `threadbase://pair?url=${encodeURIComponent(url)}&token=${token}&exp=${expSeconds}` +
    (e2eeOffered ? `&spk=${identityKey()}&v=1` : "");
  const qr = await generateQr(payload);

  log.info(printUrlBanner({ url, qr, expiresAt }));
  log.info(`Pair URL: ${payload}`);
  log.info(`Expires in ${expiresInSeconds}s`);
}
