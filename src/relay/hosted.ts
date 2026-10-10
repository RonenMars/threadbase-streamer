// The hosted Threadbase relay, used by a server started from the CLI when
// server.yaml names no relay of its own. The public key is pinned, so rotating
// the relay's key takes a streamer release that carries the new one.
const HOSTED_RELAY_URL = "wss://relay.threadbase.sh/tunnel";
const HOSTED_RELAY_PUBLIC_KEY = "4ba23-GN46vx3UARG7KvzT63Y-4JRXem3ExSROlw3jM";

/**
 * The relay server.yaml names, or the hosted one when it names none. A
 * half-configured relay is returned as it is, so the server reports it as not
 * configured: the hosted key must never vouch for somebody else's relay.
 */
export function relaySettings(
  url: string | undefined,
  publicKey: string | undefined,
): { relayUrl: string | undefined; relayPublicKey: string | undefined } {
  if (url === undefined && publicKey === undefined) {
    return { relayUrl: HOSTED_RELAY_URL, relayPublicKey: HOSTED_RELAY_PUBLIC_KEY };
  }
  return { relayUrl: url, relayPublicKey: publicKey };
}
