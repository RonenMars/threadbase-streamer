// The address a client dials to reach this streamer through the relay.
//
// The relay derives the same route id from the identity key the tunnel
// handshake authenticates, so this is a locator and never a credential: knowing
// it lets a client find the tunnel, and everything sent to it is still sealed
// to that same key.

import { createHash } from "node:crypto";

const ROUTE_DOMAIN = Buffer.from("threadbase-relay/1 route", "utf-8");
const ROUTE_ID_CHARS = 32;

export function relayRouteId(streamerPublicKey: Buffer): string {
  return createHash("sha256")
    .update(ROUTE_DOMAIN)
    .update(streamerPublicKey)
    .digest("base64url")
    .slice(0, ROUTE_ID_CHARS);
}

/**
 * `wss://relay.example.com/tunnel` → `https://relay.example.com/r/<routeId>`.
 *
 * Null for a `relay_url` that does not parse: the connector reports that on its
 * own, and an address nobody can dial is worse than none.
 */
export function relayClientUrl(tunnelUrl: string, streamerPublicKey: Buffer): string | null {
  let url: URL;
  try {
    url = new URL(tunnelUrl);
  } catch {
    return null;
  }
  const scheme = url.protocol === "ws:" || url.protocol === "http:" ? "http" : "https";
  return `${scheme}://${url.host}/r/${relayRouteId(streamerPublicKey)}`;
}
