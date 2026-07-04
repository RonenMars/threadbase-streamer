import { vi } from "vitest";

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, platform: () => "darwin", homedir: () => "/Users/test" };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: (p: string) => p === "/opt/homebrew/bin/claude" || p === "/opt/homebrew/bin/codex",
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

describe("resolveCodexExe (macOS fallback)", () => {
  it("returns the Homebrew path when which fails but the binary exists", async () => {
    vi.resetModules();
    const { resolveCodexExe } = await import("../src/platform");
    expect(resolveCodexExe()).toBe("/opt/homebrew/bin/codex");
  });

  it("falls back to the bare command name when no candidate exists", async () => {
    vi.resetModules();
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return { ...actual, existsSync: () => false };
    });
    const { resolveCodexExe } = await import("../src/platform");
    expect(resolveCodexExe()).toBe("codex");
  });
});
