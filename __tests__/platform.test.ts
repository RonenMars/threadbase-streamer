import { vi } from "vitest";

// This file tests platform.ts itself, so it must see the real module rather
// than the "both provider CLIs are installed" stand-in every other suite gets
// from __tests__/setup/provider-installed.ts — that stand-in resolves the real
// module before the fs/os mocks below are in place, so resolution would run
// against the actual machine instead of the fixtures.
vi.unmock("../src/platform");

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

describe("resolveClaudeExe (Windows where.exe filtering)", () => {
  it("skips an extension-less shim ahead of a real .exe/.cmd match", async () => {
    vi.resetModules();
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, platform: () => "win32", homedir: () => "C:\\Users\\test" };
    });
    vi.doMock("child_process", () => ({
      // where.exe lists the npm POSIX shim (no extension — not a valid Win32
      // image) before the working .cmd shim, matching real-world PATH order.
      execFileSync: () => "C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\nC:\\npm\\claude.ps1\r\n",
    }));
    const { resolveClaudeExe } = await import("../src/platform");
    expect(resolveClaudeExe()).toBe("C:\\npm\\claude.cmd");
  });

  it("falls back to the candidate paths when where.exe only finds non-executable matches", async () => {
    vi.resetModules();
    // resolveClaudeExe() builds the candidate with the real `path.join`, which
    // uses the host OS's separator regardless of the mocked platform() above
    // (a "\\"-joined literal here would silently never match on a POSIX CI
    // runner) — build the expectation the same way so it matches on any host.
    const { join } = await vi.importActual<typeof import("path")>("path");
    const expectedCandidate = join("C:\\Users\\test", ".local", "bin", "claude.exe");
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, platform: () => "win32", homedir: () => "C:\\Users\\test" };
    });
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: (p: string) => p === expectedCandidate,
      };
    });
    vi.doMock("child_process", () => ({
      execFileSync: () => "C:\\npm\\claude\r\n",
    }));
    const { resolveClaudeExe } = await import("../src/platform");
    expect(resolveClaudeExe()).toBe(expectedCandidate);
  });
});

describe("clearClaudeExeCache", () => {
  it("forces the next resolveClaudeExe() call to re-resolve instead of reusing the memoized path", async () => {
    vi.resetModules();
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, platform: () => "darwin", homedir: () => "/Users/test" };
    });
    let existsResult = "/opt/homebrew/bin/claude";
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return { ...actual, existsSync: (p: string) => p === existsResult };
    });
    vi.doMock("child_process", () => ({
      execFileSync: () => {
        throw new Error("which not available in test");
      },
    }));
    const { resolveClaudeExe, clearClaudeExeCache } = await import("../src/platform");

    expect(resolveClaudeExe()).toBe("/opt/homebrew/bin/claude");

    // Binary moved (reinstall) — without invalidation this would keep
    // returning the now-stale path for the rest of the process lifetime.
    existsResult = "/usr/local/bin/claude";
    expect(resolveClaudeExe()).toBe("/opt/homebrew/bin/claude");

    clearClaudeExeCache();
    expect(resolveClaudeExe()).toBe("/usr/local/bin/claude");
  });
});
