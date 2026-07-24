/**
 * Scoped device capabilities (C5).
 * See docs/architecture/2026-07-24-device-identity-and-capabilities.md.
 *
 * Authorization was all-or-nothing: authMiddleware asked one question — is this
 * token the API key — and answered 401 or full access. A device paired merely to
 * glance at session status held exactly the authority of the one driving the
 * agent, because there was only ever one credential and no principal to scope.
 */

export const CAPABILITIES = [
  "history:read", // read conversations, search
  "session:control", // start, resume, send input, interrupt
  "fs:browse", // browse the project tree
  "fs:upload", // upload files into a project
  "notifications", // register for push
  "admin", // rotate keys, manage devices
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Everything except `admin`. What a normal driving device gets — it can run the
 * agent, but not rotate credentials or revoke other devices.
 */
export const FULL_CAPABILITIES: Capability[] = [
  "history:read",
  "session:control",
  "fs:browse",
  "fs:upload",
  "notifications",
];

/**
 * Read-only monitoring. The mode that makes a "just show me what's happening"
 * device safe to pair, and the one C5 explicitly calls for.
 */
export const READ_ONLY_CAPABILITIES: Capability[] = ["history:read"];

export type CapabilityPreset = "full" | "read-only";

export function capabilitiesForPreset(preset: CapabilityPreset): Capability[] {
  return preset === "read-only" ? [...READ_ONLY_CAPABILITIES] : [...FULL_CAPABILITIES];
}

/**
 * The principal behind a request.
 *
 * `legacy` is the shared API key: it predates device identity, so it carries the
 * full preset and no device id. Keeping it working is what lets this ship
 * without breaking every already-paired device.
 */
export interface Principal {
  kind: "device" | "legacy";
  deviceId?: string;
  capabilities: Capability[];
}

export function legacyPrincipal(): Principal {
  return { kind: "legacy", capabilities: [...FULL_CAPABILITIES] };
}

export function hasCapability(principal: Principal, required: Capability): boolean {
  return principal.capabilities.includes(required);
}

/**
 * Capability required to reach a route.
 *
 * Matching is longest-prefix so a specific rule beats a general one. Returning
 * `null` means "no rule" — and the caller DENIES in that case rather than
 * allowing, so a newly added route is inaccessible until someone classifies it.
 * Failing closed is the whole point: a forgotten mapping should surface as a
 * broken feature in review, never as an unguarded endpoint in production.
 */
const ROUTE_CAPABILITIES: ReadonlyArray<[prefix: string, capability: Capability]> = [
  // Most specific first for readability; matching sorts by length anyway.
  ["/api/sessions/", "session:control"],
  ["/api/sessions", "history:read"], // listing sessions is a read
  ["/api/conversations", "history:read"],
  ["/api/projects", "history:read"],
  ["/api/search", "history:read"],
  ["/api/providers", "history:read"],
  ["/api/browse", "fs:browse"],
  ["/api/upload", "fs:upload"],
  ["/api/push", "notifications"],
  ["/api/devices", "admin"],
  ["/api/config", "admin"],
  ["/api/rotate-key", "admin"],
];

export function requiredCapability(path: string, method: string): Capability | null {
  // A read of the session list is not the same authority as driving a session.
  // GET /api/sessions/:id and its sub-resources are reads; writes to them are
  // control. Without this split a read-only device could not see a session at
  // all, which would make the mode useless.
  if (path.startsWith("/api/sessions") && (method === "GET" || method === "HEAD")) {
    return "history:read";
  }

  let best: { len: number; cap: Capability } | null = null;
  for (const [prefix, cap] of ROUTE_CAPABILITIES) {
    if (path.startsWith(prefix) && (best === null || prefix.length > best.len)) {
      best = { len: prefix.length, cap };
    }
  }
  return best?.cap ?? null;
}
