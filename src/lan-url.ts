import { createSocket } from "dgram";
import { networkInterfaces } from "os";
import { getLogger } from "./logger";

const log = getLogger("lan-url");

export interface ResolveOpts {
  publicUrl: string | null;
  port: number;
}

export function resolveServerUrl({ publicUrl, port }: ResolveOpts): string {
  if (publicUrl) return publicUrl;
  return resolveLanUrl(port) ?? `http://localhost:${port}`;
}

/** The machine's first non-internal IPv4 as a URL, or null when it has none. */
export function resolveLanUrl(port: number): string | null {
  const lan = firstLanIPv4();
  return lan ? `http://${lan}:${port}` : null;
}

let routedAddress: string | null = null;

/**
 * The source address the routing table would use for a non-local destination,
 * via a connected UDP socket (no packet is sent). Rejects when there is no route.
 */
function probeDefaultRoute(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.connect(80, "192.0.2.1", () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}

/**
 * Resolve the default-route address once so the sync `resolveServerUrl` can prefer it
 * over enumeration order (#604). A failed lookup leaves the first-interface fallback.
 */
export async function detectRoutedAddress(probe: () => Promise<string> = probeDefaultRoute) {
  routedAddress = await probe().catch(() => null);
  const lan = pickLanIPv4();
  if (lan) log.info("pair.lan_address", { ...lan }, "pino");
}

function firstLanIPv4(): string | null {
  return pickLanIPv4()?.address ?? null;
}

function pickLanIPv4(): { address: string; iface: string; routed: boolean } | null {
  const ifaces = networkInterfaces();
  let first: { address: string; iface: string; routed: boolean } | null = null;
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address === routedAddress) return { address: addr.address, iface, routed: true };
      first ??= { address: addr.address, iface, routed: false };
    }
  }
  return first;
}
