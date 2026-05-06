import { vi } from "vitest";

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, platform: () => "darwin", homedir: () => "/Users/test" };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: (p: string) => p === "/opt/homebrew/bin/claude",
  };
});

vi.mock("child_process", () => ({
  execFileSync: () => {
    throw new Error("which not available in test");
  },
}));

describe("resolveClaudeExe (macOS fallback)", () => {
  it("returns the Homebrew path when which fails but the binary exists", async () => {
    vi.resetModules();
    const { resolveClaudeExe } = await import("../src/platform");
    expect(resolveClaudeExe()).toBe("/opt/homebrew/bin/claude");
  });
});
