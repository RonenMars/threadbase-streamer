import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  type Capability,
  capabilitiesForPreset,
  FULL_CAPABILITIES,
  hasCapability,
  isCapability,
  legacyPrincipal,
  READ_ONLY_CAPABILITIES,
  requiredCapability,
} from "../src/services/security/capabilities";

/**
 * Scoped capabilities (C5).
 * See docs/architecture/2026-07-24-device-identity-and-capabilities.md.
 */

describe("presets", () => {
  // A driving device must not be able to revoke other devices or rotate the
  // credential every device depends on.
  it("excludes admin from the full preset", () => {
    expect(FULL_CAPABILITIES).not.toContain("admin");
    expect(capabilitiesForPreset("full")).not.toContain("admin");
  });

  it("grants read-only devices history and nothing else", () => {
    expect(READ_ONLY_CAPABILITIES).toEqual(["history:read"]);
    expect(capabilitiesForPreset("read-only")).toEqual(["history:read"]);
  });

  it("is strictly weaker for read-only than for full", () => {
    for (const cap of capabilitiesForPreset("read-only")) {
      expect(capabilitiesForPreset("full")).toContain(cap);
    }
    expect(capabilitiesForPreset("read-only").length).toBeLessThan(
      capabilitiesForPreset("full").length,
    );
  });

  it("returns copies so a caller cannot mutate the shared preset", () => {
    const a = capabilitiesForPreset("full");
    a.push("admin");
    expect(capabilitiesForPreset("full")).not.toContain("admin");
  });
});

describe("isCapability", () => {
  it("accepts known capabilities and rejects everything else", () => {
    expect(isCapability("history:read")).toBe(true);
    expect(isCapability("admin")).toBe(true);
    expect(isCapability("wildcard")).toBe(false);
    expect(isCapability("*")).toBe(false);
    expect(isCapability(null)).toBe(false);
    expect(isCapability({})).toBe(false);
  });
});

describe("requiredCapability", () => {
  it.each<[string, string, Capability]>([
    ["/api/conversations", "GET", "history:read"],
    ["/api/conversations/abc", "GET", "history:read"],
    ["/api/projects", "GET", "history:read"],
    ["/api/providers", "GET", "history:read"],
    ["/api/browse?path=/x", "GET", "fs:browse"],
    ["/api/upload", "POST", "fs:upload"],
    ["/api/push/register", "POST", "notifications"],
    ["/api/devices", "GET", "admin"],
    ["/api/config/claude-flags", "PUT", "admin"],
  ])("maps %s %s to %s", (path, method, expected) => {
    expect(requiredCapability(path, method)).toBe(expected);
  });

  // Reading a session is not the same authority as driving one. Without this
  // split, read-only devices could not see sessions at all and the mode would
  // be useless.
  it("treats session reads as history and session writes as control", () => {
    expect(requiredCapability("/api/sessions", "GET")).toBe("history:read");
    expect(requiredCapability("/api/sessions/abc", "GET")).toBe("history:read");
    expect(requiredCapability("/api/sessions/abc/input", "POST")).toBe("session:control");
    expect(requiredCapability("/api/sessions/start", "POST")).toBe("session:control");
  });

  // The security-critical default. A route nobody classified must be
  // inaccessible, so the omission shows up as a broken feature in review rather
  // than an unguarded endpoint in production.
  it("returns null for an unmapped route so the caller can fail closed", () => {
    expect(requiredCapability("/api/some-brand-new-route", "POST")).toBeNull();
  });
});

describe("hasCapability", () => {
  const readOnly = { kind: "device" as const, capabilities: capabilitiesForPreset("read-only") };

  it("permits what the principal holds", () => {
    expect(hasCapability(readOnly, "history:read")).toBe(true);
  });

  it("refuses what it does not", () => {
    expect(hasCapability(readOnly, "session:control")).toBe(false);
    expect(hasCapability(readOnly, "fs:upload")).toBe(false);
    expect(hasCapability(readOnly, "admin")).toBe(false);
  });

  // The shared API key predates device identity and is the OWNER's credential:
  // it pairs new devices and rotates itself, so it must hold admin. Devices are
  // the things that get scoped; the key that mints them cannot be, or the owner
  // could no longer administer their own server.
  it("gives the legacy shared key full authority including admin", () => {
    const legacy = legacyPrincipal();
    expect(legacy.kind).toBe("legacy");
    expect(legacy.deviceId).toBeUndefined();
    expect(hasCapability(legacy, "session:control")).toBe(true);
    expect(hasCapability(legacy, "admin")).toBe(true);
  });

  // A device, by contrast, never gets admin from a preset — that is the whole
  // point of scoping.
  it("never grants admin through a device preset", () => {
    for (const preset of ["full", "read-only"] as const) {
      expect(capabilitiesForPreset(preset)).not.toContain("admin");
    }
  });
});

/**
 * The fail-closed guarantee.
 *
 * authMiddleware lets an UNCLASSIFIED path fall through to the router, so an
 * unknown route still 404s rather than 403ing (a 403 would tell an
 * authenticated caller that a path it cannot name might exist). That is only
 * safe if every route the app actually mounts is classified — which is what
 * this test enforces. A new endpoint added without a mapping fails here.
 */
describe("every mounted route is classified", () => {
  const ROUTES_DIR = join(__dirname, "..", "src", "api", "routes");

  // Paths the middleware deliberately serves without a capability check.
  const EXEMPT = [
    "/healthz",
    "/api/pair/exchange", // public: the pairing handshake itself
    "/api/__update", // HMAC-signed webhook
    "/internal/sessions", // HMAC-signed progress webhook
    "/api/logs", // localhost-only, bypassed earlier in the middleware
  ];

  it("maps a capability for every /api and /ws path in the route files", () => {
    const mounted = new Set<string>();
    for (const file of readdirSync(ROUTES_DIR)) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      for (const m of src.matchAll(/"(\/(?:api|internal|ws)[^"]*)"/g)) {
        // Strip Hono param/regex segments — only the static prefix matters for
        // longest-prefix classification.
        const path = m[1].split("/:")[0].split("{")[0];
        if (path.length > 1) mounted.add(path);
      }
    }

    expect(mounted.size).toBeGreaterThan(5);

    const unclassified = [...mounted].filter(
      (p) => !EXEMPT.some((e) => p.startsWith(e)) && requiredCapability(p, "GET") === null,
    );

    expect(unclassified, `unclassified routes: ${unclassified.join(", ")}`).toEqual([]);
  });
});
