import { networkInterfaces } from "os";

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

function firstLanIPv4(): string | null {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name] ?? [];
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}
