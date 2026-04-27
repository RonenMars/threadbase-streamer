import { networkInterfaces } from "os";

export interface ResolveOpts {
  publicUrl: string | null;
  port: number;
}

export function resolveServerUrl({ publicUrl, port }: ResolveOpts): string {
  if (publicUrl) return publicUrl;
  const lan = firstLanIPv4();
  if (lan) return `http://${lan}:${port}`;
  return `http://localhost:${port}`;
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
