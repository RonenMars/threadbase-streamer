import { execFile } from "child_process";
import { describe, expect, it, vi } from "vitest";
import {
  compareSemver,
  compareToVerified,
  parseVersionOutput,
  providerHealth,
} from "../src/services/providers/providerHealth";

// Only the version probe reaches child_process; every test below that cares
// about a version injects its own detector instead.
vi.mock("child_process", () => ({
  execFile: vi.fn((_file, _args, _opts, cb) => cb(null, "2.1.214 (Claude Code)", "")),
  execFileSync: vi.fn(() => ""),
}));

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
  // A real executable: availability is now a filesystem fact, not the absence
  // of a throw, so a made-up path would report the provider as missing.
  const found = () => process.execPath;
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

  // The case that actually happens, and the one this endpoint used to get
  // wrong: nothing throws when a CLI is absent — `resolveClaudeExe()` exhausts
  // its lookups and returns the bare name — so gating availability on a throw
  // reported a missing CLI as available:true, and mobile (which greys a
  // provider out on available === false) left the button live. Whether a given
  // path or bare name resolves to anything is `locateExecutable`'s question,
  // covered in provider-not-installed.test.ts; here it arrives as null.
  it("reports a provider that cannot be located as unavailable", async () => {
    const health = await providerHealth("claude-code", () => null);

    expect(health.available).toBe(false);
    expect(health.version).toBeNull();
    expect(health.warnings[0].code).toBe("provider_not_found");
  });

  // `--version` is the only part of a health check that spawns a process (85ms
  // for claude on macOS), and mobile re-asks every 60s while a user browses.
  // The binary cannot change under a running streamer without someone
  // replacing it, so it is read once per executable. Availability is
  // deliberately NOT cached with it — see the memo's comment.
  it("reads --version once per executable, not once per request", async () => {
    const spawned = vi.mocked(execFile);
    spawned.mockClear();
    const locate = () => process.execPath;

    const first = await providerHealth("claude-code", locate);
    const second = await providerHealth("claude-code", locate);

    expect(spawned).toHaveBeenCalledOnce();
    expect(first.version).toBe("2.1.214");
    expect(second.version).toBe("2.1.214");
  });

  // An unreadable version is not evidence the CLI is broken — resolveExe found
  // it. Report available, flag compatibility unknown.
  it("stays available when the version cannot be read", async () => {
    const health = await providerHealth("claude-code", found, async () => null);

    expect(health.available).toBe(true);
    expect(health.warnings[0].code).toBe("version_undetectable");
  });

  // `detect` is an injected seam, so the guard has to hold for whatever is
  // behind it — including a detector that throws rather than resolving null.
  // Before the guard this rejection escaped providerHealth and took the whole
  // GET /api/providers response down with it.
  it("stays available when the detector throws", async () => {
    const health = await providerHealth("claude-code", found, async () => {
      throw new Error("spawn EINVAL");
    });

    expect(health.available).toBe(true);
    expect(health.version).toBeNull();
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
