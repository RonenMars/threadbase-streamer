import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 of the live-sessions-persistence plan: a stored pid is only
 * probeable within the boot it was recorded in.
 */

/** Mutable stand-in for the machine, shared with the mock factories below. */
const machine = { bootId: "" as string | Error, uptimeSeconds: 0 };

vi.mock("node:fs", () => ({
  readFileSync: () => {
    if (machine.bootId instanceof Error) throw machine.bootId;
    return machine.bootId;
  },
}));

vi.mock("node:os", () => ({ default: { uptime: () => machine.uptimeSeconds } }));

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** A fresh module instance, so the per-process memo starts empty. */
async function loadBootToken(): Promise<() => string> {
  vi.resetModules();
  return (await import("../src/utils/bootToken")).currentBootToken;
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.useRealTimers();
});

describe("currentBootToken", () => {
  it("computes once per process and returns the same value on every call", async () => {
    setPlatform("linux");
    machine.bootId = "9d1a-boot\n";

    const currentBootToken = await loadBootToken();
    const first = currentBootToken();

    // A second read of the machine would see this; a memoised token must not.
    machine.bootId = "some-other-boot";
    expect(currentBootToken()).toBe(first);
    expect(first).toBe("9d1a-boot");
  });

  it("uses the kernel boot id on Linux, with no clock involved", async () => {
    setPlatform("linux");
    machine.bootId = "1b2c3d4e-5f60-7182-93a4-b5c6d7e8f900\n";
    machine.uptimeSeconds = 999_999;

    const currentBootToken = await loadBootToken();
    expect(currentBootToken()).toBe("1b2c3d4e-5f60-7182-93a4-b5c6d7e8f900");
  });

  it("falls back to a bucketed uptime estimate when boot_id is unreadable", async () => {
    setPlatform("linux");
    machine.bootId = Object.assign(new Error("EACCES"), { code: "EACCES" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
    machine.uptimeSeconds = 3600;

    const currentBootToken = await loadBootToken();
    const bootInstant = Date.parse("2026-07-31T12:00:00Z") - 3_600_000;
    expect(currentBootToken()).toBe(String(Math.round(bootInstant / 10_000)));
  });

  it("derives from uptime off Linux, and differs across boots", async () => {
    setPlatform("darwin");
    machine.bootId = "never read on darwin";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));

    machine.uptimeSeconds = 3600;
    const beforeReboot = (await loadBootToken())();

    // Same wall clock, machine rebooted a minute ago.
    machine.uptimeSeconds = 60;
    const afterReboot = (await loadBootToken())();

    expect(beforeReboot).not.toBe(afterReboot);
  });

  it("absorbs sub-bucket drift within one boot", async () => {
    setPlatform("darwin");
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
    machine.uptimeSeconds = 3600;
    const early = (await loadBootToken())();

    // 5s later, uptime advanced by 4s — the same 10s bucket.
    vi.setSystemTime(new Date("2026-07-31T12:00:05Z"));
    machine.uptimeSeconds = 3604;
    const later = (await loadBootToken())();

    expect(later).toBe(early);
  });
});
