import { readFileSync } from "fs";
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
 *
 * The guarantee is build-time, not runtime, so this test IS the control. It
 * used to scan the route files for literals already beginning `/api`,
 * `/internal` or `/ws` — which silently skipped every sub-app mounted at a
 * prefix, because those files write their paths RELATIVE to the mount
 * (`sessions.routes.ts` says `"/:id/input"`, not `"/api/sessions/:id/input"`).
 * A whole new mount prefix added to `app.ts` therefore passed without ever
 * being classified. Reconstructing the full path from mount + literal is what
 * closes that.
 */
describe("every mounted route is classified", () => {
  const API_DIR = join(__dirname, "..", "src", "api");

  // Paths the middleware deliberately serves without a capability check.
  const EXEMPT = [
    "/healthz",
    "/api/pair/exchange", // public: the pairing handshake itself
    "/api/__update", // HMAC-signed webhook
    "/internal/sessions", // HMAC-signed progress webhook
    "/api/logs", // localhost-only, bypassed earlier in the middleware
  ];

  /** Join a mount prefix with a sub-app's own literal, as Hono does. */
  function joinPath(prefix: string, sub: string): string {
    const base = prefix === "/" ? "" : prefix.replace(/\/+$/, "");
    if (sub === "/" || sub === "") return base || "/";
    return `${base}${sub.startsWith("/") ? sub : `/${sub}`}`;
  }

  /** Strip Hono param/regex segments — only the static prefix classifies. */
  function staticPrefix(path: string): string {
    return path.split("/:")[0].split("{")[0].replace(/\/+$/, "") || "/";
  }

  /**
   * Every path the Hono app can actually serve, reconstructed as
   * `mount prefix + the sub-app's own literal`.
   */
  function collectMountedPaths(): string[] {
    const appSrc = readFileSync(join(API_DIR, "app.ts"), "utf8");

    // `import { createSessionRoutes } from "./routes/sessions.routes";`
    const fileForFactory = new Map<string, string>();
    for (const m of appSrc.matchAll(
      /import\s*\{\s*(create\w+)\s*\}\s*from\s*"\.\/(routes\/[\w.-]+)"/g,
    )) {
      fileForFactory.set(m[1], `${m[2]}.ts`);
    }

    // `app.route("/api/sessions", createSessionRoutes(deps));`
    const mounts: Array<[prefix: string, factory: string]> = [];
    for (const m of appSrc.matchAll(/app\.route\(\s*"([^"]*)"\s*,\s*(create\w+)\s*\(/g)) {
      mounts.push([m[1], m[2]]);
    }

    const paths = new Set<string>();
    for (const [prefix, factory] of mounts) {
      const file = fileForFactory.get(factory);
      // A mount whose factory we cannot resolve to a file would silently
      // contribute nothing, which is the exact failure this test exists to
      // prevent — so surface it instead of skipping it.
      expect(file, `no import found for ${factory} mounted at ${prefix}`).toBeDefined();
      const routeSrc = readFileSync(join(API_DIR, file as string), "utf8");
      for (const r of routeSrc.matchAll(
        /app\.(?:get|post|put|patch|delete|options|all|on)\(\s*"([^"]*)"/g,
      )) {
        paths.add(staticPrefix(joinPath(prefix, r[1])));
      }
    }
    return [...paths];
  }

  it("resolves every mount in app.ts to real paths", () => {
    const mounted = collectMountedPaths();

    // Positive control: the reconstruction must actually find the paths whose
    // classification matters most. Without this, a regex that matched nothing
    // would make the assertion below pass vacuously.
    expect(mounted).toContain("/api/sessions"); // from mount + "/:id/input"
    expect(mounted).toContain("/api/conversations");
    expect(mounted).toContain("/api/pair/exchange"); // relative "/exchange"
    expect(mounted).toContain("/ws"); // mounted at "/"
    expect(mounted.length).toBeGreaterThan(15);
  });

  it("maps a capability for every mounted path", () => {
    const unclassified = collectMountedPaths().filter(
      (p) => !EXEMPT.some((e) => p.startsWith(e)) && requiredCapability(p, "GET") === null,
    );

    expect(unclassified, `unclassified routes: ${unclassified.join(", ")}`).toEqual([]);
  });
});
