// Phase 7a of the live-sessions persistence plan: the persisted answer behind
// auto-resume on boot.
//
// The property under test is the tri-state. `undefined` means "never asked" and
// is what triggers the one-time prompt; `false` is a real answer that must
// never be re-asked. Collapsing the two either nags on every boot or silently
// decides for someone who was never given the choice.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let homeDir: string;
let configFile: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let setAutoResumeOnBoot: (value: boolean) => void;
let loadAutoResumeOnBoot: () => boolean | undefined;
let setDefaultPermissionMode: (mode: "acceptEdits" | "manual") => void;

function writeConfig(contents: string): void {
  mkdirSync(join(homeDir, ".threadbase"), { recursive: true });
  writeFileSync(configFile, contents);
}

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "tb-auto-resume-"));
  configFile = join(homeDir, ".threadbase", "server.yaml");
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  vi.resetModules();
  ({ setAutoResumeOnBoot, loadAutoResumeOnBoot, setDefaultPermissionMode } = await import(
    "../src/auth"
  ));
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  else delete process.env.USERPROFILE;
});

describe("loadAutoResumeOnBoot", () => {
  it("returns undefined when server.yaml does not exist", () => {
    expect(loadAutoResumeOnBoot()).toBeUndefined();
  });

  it("returns undefined when the key is absent — the 'never asked' case", () => {
    writeConfig("api_key: tb_abc\n");
    expect(loadAutoResumeOnBoot()).toBeUndefined();
  });

  it("reads both real answers", () => {
    writeConfig("auto_resume_on_boot: true\n");
    expect(loadAutoResumeOnBoot()).toBe(true);

    writeConfig("auto_resume_on_boot: false\n");
    expect(loadAutoResumeOnBoot()).toBe(false);
  });

  it("distinguishes a recorded false from an absent key", () => {
    // The whole point of the tri-state: `false` is an answer, and re-asking it
    // every boot would be the bug.
    writeConfig("auto_resume_on_boot: false\n");
    expect(loadAutoResumeOnBoot()).toBe(false);
    expect(loadAutoResumeOnBoot()).not.toBeUndefined();
  });

  it("treats a malformed value as never-asked rather than coercing it", () => {
    // Anything other than a literal true/false must re-prompt. Coercing a typo
    // toward `true` would silently enable unattended agent starts.
    for (const value of ["yes", "1", "TRUE", "", "maybe"]) {
      writeConfig(`auto_resume_on_boot: ${value}\n`);
      expect(loadAutoResumeOnBoot()).toBeUndefined();
    }
  });

  it("is anchored to its own line and does not match a lookalike key", () => {
    writeConfig("x_auto_resume_on_boot: true\n");
    expect(loadAutoResumeOnBoot()).toBeUndefined();
  });

  it("reads the key from among other settings", () => {
    writeConfig("api_key: tb_abc\nauto_resume_on_boot: true\nbrowse_root: /srv\n");
    expect(loadAutoResumeOnBoot()).toBe(true);
  });
});

describe("setAutoResumeOnBoot", () => {
  it("round-trips through server.yaml", () => {
    setAutoResumeOnBoot(true);
    expect(readFileSync(configFile, "utf-8")).toContain("auto_resume_on_boot: true");
    expect(loadAutoResumeOnBoot()).toBe(true);
  });

  it("persists a `no` as an explicit false, which is what stops the re-ask", () => {
    setAutoResumeOnBoot(false);
    expect(loadAutoResumeOnBoot()).toBe(false);
  });

  it("replaces an existing answer rather than appending a second line", () => {
    setAutoResumeOnBoot(true);
    setAutoResumeOnBoot(false);

    const lines = readFileSync(configFile, "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("auto_resume_on_boot:"));
    expect(lines).toEqual(["auto_resume_on_boot: false"]);
  });

  it("leaves neighbouring keys intact", () => {
    writeConfig("api_key: tb_abc\nbrowse_root: /srv\n");
    setAutoResumeOnBoot(true);

    const content = readFileSync(configFile, "utf-8");
    expect(content).toContain("api_key: tb_abc");
    expect(content).toContain("browse_root: /srv");
    expect(content).toContain("auto_resume_on_boot: true");
  });

  it("does not disturb default_permission_mode, the setting it sits beside", () => {
    setDefaultPermissionMode("manual");
    setAutoResumeOnBoot(true);

    expect(readFileSync(configFile, "utf-8")).toContain("default_permission_mode: manual");
    expect(loadAutoResumeOnBoot()).toBe(true);
  });
});
