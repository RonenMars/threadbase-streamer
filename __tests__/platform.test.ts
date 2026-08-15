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

// The PATH walk behaves differently enough on Windows that it cannot be
// covered from a POSIX runner by the temp-dir tests in
// provider-not-installed.test.ts — the extension handling is the whole
// difference, and the Windows smoke job is the only place it runs for real.
describe("locateExecutable (Windows extension handling)", () => {
  // No drive letter: PATH is split on the HOST's delimiter, which is ":" on a
  // POSIX runner, so a "C:\tools" fixture would silently become two entries and
  // match nothing. Same host-vs-mocked-platform trap as the join() note above.
  const TOOLS_DIR = "tools-fixture";
  const previousPath = process.env.PATH;

  afterAll(() => {
    process.env.PATH = previousPath;
  });

  const winFs = (present: Set<string>) => {
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return { ...actual, platform: () => "win32", homedir: () => "C:\\Users\\test" };
    });
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        statSync: (p: string) => {
          if (!present.has(p)) throw new Error("ENOENT");
          return { isFile: () => true };
        },
        accessSync: (p: string) => {
          if (!present.has(p)) throw new Error("ENOENT");
        },
      };
    });
  };

  // A name that already carries an extension must be tried as written. Only
  // appending turned `node.exe` into `node.exe.exe` and found nothing.
  it("tries a name that already carries an executable extension as written", async () => {
    vi.resetModules();
    const { join } = await vi.importActual<typeof import("path")>("path");
    const target = join(TOOLS_DIR, "claude.cmd");
    winFs(new Set([target]));
    const { locateExecutable } = await import("../src/platform");
    process.env.PATH = TOOLS_DIR;

    expect(locateExecutable("claude.cmd")).toBe(target);
  });

  it("appends an executable extension to a bare name", async () => {
    vi.resetModules();
    const { join } = await vi.importActual<typeof import("path")>("path");
    const target = join(TOOLS_DIR, "claude.cmd");
    winFs(new Set([target]));
    const { locateExecutable } = await import("../src/platform");
    process.env.PATH = TOOLS_DIR;

    expect(locateExecutable("claude")).toBe(target);
  });

  // Permissions do not make a file launchable on Windows; the extension does.
  it("refuses an extension-less file even when it is present", async () => {
    vi.resetModules();
    const { join } = await vi.importActual<typeof import("path")>("path");
    winFs(new Set([join(TOOLS_DIR, "claude")]));
    const { locateExecutable } = await import("../src/platform");
    process.env.PATH = TOOLS_DIR;

    expect(locateExecutable("claude")).toBeNull();
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
