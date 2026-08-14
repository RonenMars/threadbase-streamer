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
  type Principal,
  READ_ONLY_CAPABILITIES,
  requiredCapability,
} from "../src/services/security/capabilities";

/**
 * Scoped capabilities (C5).
 * See docs/architecture/2026-07-24-device-identity-and-capabilities.md.
 */

describe("presets", () => {
  // The full preset holds admin, because on this product the phone IS the
  // administration surface: the paired-devices screen, backup and restore, and
  // the model and effort settings are all admin-gated routes that mobile calls.
  // A driving device without admin loses them the moment it presents its own
  // token instead of the shared key.
  it("includes admin in the full preset", () => {
    expect(FULL_CAPABILITIES).toContain("admin");
    expect(capabilitiesForPreset("full")).toContain("admin");
  });

  // The narrowing lives in read-only, and that is the whole of it.
  it("withholds admin from read-only", () => {
    expect(capabilitiesForPreset("read-only")).not.toContain("admin");
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

  // The sentinel is a non-capability rather than "admin", which the full preset
  // now legitimately holds — pushing a value the preset already contains would
  // pass whether or not a copy was returned.
  it("returns copies so a caller cannot mutate the shared preset", () => {
    const a = capabilitiesForPreset("full");
    (a as string[]).push("not-a-capability");
    expect(capabilitiesForPreset("full")).not.toContain("not-a-capability");

    const b = capabilitiesForPreset("read-only");
    b.pop();
    expect(capabilitiesForPreset("read-only")).toEqual(["history:read"]);
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

  // A full device now holds exactly what the shared key holds. That is the
  // model this product actually has — one person, many of their own devices —
  // and it is what keeps mobile's admin-gated screens working once a device
  // presents its own token (#684) rather than the shared key.
  it("gives a full device the same authority as the shared key", () => {
    expect(new Set(capabilitiesForPreset("full"))).toEqual(new Set(legacyPrincipal().capabilities));
  });

  // The routes that broke without this. Each is a real endpoint mobile calls:
  // the paired-devices screen, backup and restore, and the model/effort
  // settings. Asserted through requiredCapability so a change to the route
  // table is caught here rather than as a 403 on someone's phone.
  it.each([
    ["/api/devices", "GET"],
    ["/api/backup/export", "GET"],
    ["/api/backup/restore", "POST"],
    ["/api/config/claude-flags", "GET"],
    ["/api/config/claude-flags", "PUT"],
  ])("lets a full device reach %s %s", (path, method) => {
    const required = requiredCapability(path, method);
    expect(required).not.toBeNull();
    const device: Principal = {
      kind: "device",
      deviceId: "dev-1",
      capabilities: capabilitiesForPreset("full"),
    };
    expect(hasCapability(device, required as Capability)).toBe(true);
  });

  // The positive control for the case above: a read-only device is still
  // refused those same routes, so the assertions prove a capability check
  // rather than an absent one.
  it.each([
    ["/api/devices", "GET"],
    ["/api/backup/export", "GET"],
    ["/api/config/claude-flags", "PUT"],
  ])("still refuses a read-only device %s %s", (path, method) => {
    const required = requiredCapability(path, method);
    const device: Principal = {
      kind: "device",
      deviceId: "dev-2",
      capabilities: capabilitiesForPreset("read-only"),
    };
    expect(hasCapability(device, required as Capability)).toBe(false);
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
