import { currentServerIdentityFingerprint, serverIdentityKeyPath } from "../src/server-identity";

export interface IdentityDeps {
  log: { info: (msg: string) => void; error: (msg: string) => void };
  /** Overridable for tests; defaults to the real on-disk key. */
  fingerprint?: () => string;
  keyPath?: () => string;
}

/**
 * `serverIdentityPublicKey()` throws when the key file exists but can't be
 * read (src/server-identity.ts), rather than minting a replacement that would
 * silently invalidate every paired device. `/api/info` absorbs that by
 * omitting the field (misc.routes.ts) because it serves a lot else besides.
 * This command's only job is showing the key, so it does the opposite: say
 * plainly that it can't, with a non-zero exit, rather than an empty banner.
 */
export function runIdentity(deps: IdentityDeps): number {
  const keyPath = (deps.keyPath ?? serverIdentityKeyPath)();
  const fingerprint = deps.fingerprint ?? currentServerIdentityFingerprint;

  let value: string;
  try {
    value = fingerprint();
  } catch (err) {
    // The thrown message from loadOrCreateServerIdentity() already names the
    // path and the repair step (src/server-identity.ts); prefix rather than
    // duplicate it.
    deps.log.error(
      `Could not read the server identity key: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  deps.log.info(formatIdentityBanner(value, keyPath));
  return 0;
}

export function formatIdentityBanner(fingerprint: string, keyPath: string): string {
  return [
    `Server identity  (X25519, ${keyPath})`,
    "",
    `  ${fingerprint}`,
    "",
    "Compare this with the fingerprint your phone shows when you add this server.",
  ].join("\n");
}
