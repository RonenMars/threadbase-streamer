import { describe, expect, it } from "vitest";
import {
  compareSemver,
  compareToVerified,
  parseVersionOutput,
  providerHealth,
} from "../src/services/providers/providerHealth";

describe("parseVersionOutput", () => {
  // Providers format --version differently and change it between releases, so
  // this scrapes a version-shaped token rather than assuming a layout.
  it.each([
    ["2.1.214 (Claude Code)", "2.1.214"],
    ["claude 2.1.214", "2.1.214"],
    ["codex-cli 0.140.0-alpha.19", "0.140.0-alpha.19"],
    ["v1.0.0\n", "1.0.0"],
  ])("extracts a version from %j", (raw, expected) => {
    expect(parseVersionOutput(raw)).toBe(expected);
  });

  it("returns null when no version is present", () => {
    expect(parseVersionOutput("command not found")).toBeNull();
    expect(parseVersionOutput("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders release versions numerically, not lexically", () => {
    expect(compareSemver("2.1.10", "2.1.9")).toBeGreaterThan(0);
    expect(compareSemver("2.2.0", "2.10.0")).toBeLessThan(0);
    expect(compareSemver("2.1.214", "2.1.214")).toBe(0);
  });

  // Semver rule: a prerelease sorts BELOW the release it precedes, so a
  // captured alpha must not read as newer than the release that follows it.
  it("sorts a prerelease below its release", () => {
    expect(compareSemver("0.140.0-alpha.19", "0.140.0")).toBeLessThan(0);
    expect(compareSemver("0.140.0", "0.140.0-alpha.19")).toBeGreaterThan(0);
  });
});

describe("compareToVerified", () => {
  const verified = { captured: ["2.1.214"], min: "2.1.0" };

  it("does not warn for an exactly-captured version", () => {
    expect(compareToVerified("2.1.214", verified)).toBeNull();
  });

  it("warns when the version cannot be detected", () => {
    expect(compareToVerified(null, verified)?.code).toBe("version_undetectable");
  });

  it("warns for a version newer than everything captured", () => {
    expect(compareToVerified("2.9.0", verified)?.code).toBe("version_unverified");
  });

  it("warns for a version below the declared minimum", () => {
    expect(compareToVerified("1.0.0", verified)?.code).toBe("version_unverified");
  });

  // The warning must never read as a refusal — it is a compatibility note.
  it("explains that the provider still runs", () => {
    expect(compareToVerified("2.9.0", verified)?.message).toMatch(/still run/i);
  });

  it("respects an explicit max as the upper bound", () => {
    const bounded = { captured: ["1.0.0"], min: "1.0.0", max: "2.0.0" };
    expect(compareToVerified("1.5.0", bounded)).toBeNull();
    expect(compareToVerified("2.5.0", bounded)?.code).toBe("version_unverified");
  });
});

describe("providerHealth", () => {
  const found = () => "/usr/local/bin/claude";
  const missing = () => {
    throw new Error("not found");
  };

  it("reports a resolvable provider with a captured version as healthy", async () => {
    const health = await providerHealth("claude-code", found, async () => "2.1.214");

    expect(health.available).toBe(true);
    expect(health.version).toBe("2.1.214");
    expect(health.warnings).toEqual([]);
    expect(health.capabilities.resume).toBe("native");
  });

  it("reports an unresolvable provider as unavailable", async () => {
    const health = await providerHealth("claude-code", missing);

    expect(health.available).toBe(false);
    expect(health.version).toBeNull();
    expect(health.warnings[0].code).toBe("provider_not_found");
  });

  // An unreadable version is not evidence the CLI is broken — resolveExe found
  // it. Report available, flag compatibility unknown.
  it("stays available when the version cannot be read", async () => {
    const health = await providerHealth("claude-code", found, async () => null);

    expect(health.available).toBe(true);
    expect(health.warnings[0].code).toBe("version_undetectable");
  });

  it("still reports capabilities for an unverified version", async () => {
    const health = await providerHealth("codex-cli", found, async () => "9.9.9");

    expect(health.warnings[0].code).toBe("version_unverified");
    // Capabilities are structural, not version-gated: a warning must not strip
    // the client's ability to know what the provider does.
    expect(health.capabilities.freshSessionId).toBe("late-bound");
  });
});
