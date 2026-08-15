import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawn as mockSpawn } from "node-pty";
import { tmpdir } from "os";
import { basename, delimiter, dirname, join } from "path";
import { errorMiddleware } from "../src/api/middleware/error.middleware";
import { locateExecutable } from "../src/platform";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  })),
}));

/**
 * A missing provider CLI used to be indistinguishable from a healthy machine
 * until a session had already been spawned and died: on POSIX node-pty forks
 * and execvp fails inside the *child*, so spawn() succeeds, the session exits
 * milliseconds later with code 1 and no output, and the client is told only
 * that it "exited before becoming ready".
 *
 * These lock the three pieces that make it legible: the location check that can
 * actually answer "is it installed", the refusal LiveSessionManager raises
 * before spawning, and the middleware that carries that refusal's status and
 * code out to the client instead of flattening it to a bare 500.
 */

describe("locateExecutable", () => {
  // Positive control. Without it the assertions below pass just as happily
  // against a function that always returns null.
  it("finds a real executable given its absolute path", () => {
    expect(locateExecutable(process.execPath)).toBe(process.execPath);
  });

  it("finds a real executable given a bare name on PATH", () => {
    const previous = process.env.PATH;
    process.env.PATH = dirname(process.execPath) + delimiter + previous;
    try {
      expect(locateExecutable(basename(process.execPath))).toBe(process.execPath);
    } finally {
      process.env.PATH = previous;
    }
  });

  it("returns null for an absolute path to nothing", () => {
    expect(locateExecutable("/nonexistent/bin/claude")).toBeNull();
  });

  // The bare-name fallback is what resolveClaudeExe() returns when every lookup
  // failed. It is NOT proof the CLI is missing — execvp searches PATH itself,
  // and a box without /usr/bin/which resolves nothing here yet spawns fine — so
  // this has to be answered by walking PATH, not by recognising the name.
  it("returns null for a bare name that is on no PATH entry", () => {
    expect(locateExecutable("definitely-not-a-real-command-xyz")).toBeNull();
  });

  it("returns null for a directory that happens to exist", () => {
    expect(locateExecutable(dirname(process.execPath))).toBeNull();
  });

  // The configuration this walk exists for, and the one that cannot be
  // reproduced on a dev box: a container with no /usr/bin/which and none of the
  // hardcoded candidates, where resolution returns the bare name and PATH is
  // the only thing that can answer. Driven through a PATH we fully control, so
  // the result does not depend on what happens to be installed on the runner.
  describe("with a controlled PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-locate-"));
    const previous = process.env.PATH;
    // Windows resolves a bare name by appending an extension, and cannot launch
    // an extension-less file however its permissions read — so the fixture has
    // to be shaped like a command that platform can actually run. The query
    // stays bare on both, which is what exercises the append.
    const isWindows = process.platform === "win32";
    const fauxFile = isWindows ? "faux-cli.cmd" : "faux-cli";

    beforeAll(() => {
      writeFileSync(join(dir, fauxFile), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(dir, "not-executable"), "#!/bin/sh\n", { mode: 0o644 });
      process.env.PATH = dir;
    });

    afterAll(() => {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    });

    it("finds a bare name in the only PATH entry", () => {
      expect(locateExecutable("faux-cli")).toBe(join(dir, fauxFile));
    });

    it("misses a bare name that is nowhere on PATH", () => {
      expect(locateExecutable("claude")).toBeNull();
    });

    // On POSIX this is the X_OK check; on Windows it is the extension filter,
    // since an extension-less file is not a launchable command there either.
    it("does not accept a non-executable file as the command", () => {
      expect(locateExecutable("not-executable")).toBeNull();
    });

    it("misses everything when PATH is empty", () => {
      process.env.PATH = "";
      try {
        expect(locateExecutable("faux-cli")).toBeNull();
      } finally {
        process.env.PATH = dir;
      }
    });
  });
});

describe("session start with a provider that is not installed", () => {
  const startFreshFor = async (located: string | null) => {
    vi.resetModules();
    vi.doMock("../src/platform", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/platform")>()),
      locateProviderExe: () => located,
    }));
    const { LiveSessionManager } = await import("../src/live-session-manager");
    return new LiveSessionManager().startFresh({
      provider: "claude-code",
      projectPath: process.cwd(),
    });
  };

  beforeEach(() => {
    (mockSpawn as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.doUnmock("../src/platform");
    vi.resetModules();
  });

  it("refuses with the status and code mobile branches on", async () => {
    await expect(startFreshFor(null)).rejects.toMatchObject({
      statusCode: 503,
      code: "PROVIDER_NOT_INSTALLED",
    });
  });

  // Mobile shows `error` verbatim in an alert, so the message is the whole
  // remediation the user gets: which command is missing, and the PATH case.
  it("names the missing command and the PATH case", async () => {
    await expect(startFreshFor(null)).rejects.toThrow(
      /claude command was not found.*Install the claude-code CLI.*on the PATH/s,
    );
  });

  // The whole point of a pre-flight: nothing is spawned, so there is no session
  // to appear in the list, no PTY to die 12ms later, and no exit code to
  // interpret.
  it("never reaches the spawn", async () => {
    await expect(startFreshFor(null)).rejects.toThrow();

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // Positive control: the guard must be the thing that fired above, not the
  // call failing for its own reasons. With the CLI located, the same call goes
  // through to the spawn.
  it("does not refuse when the CLI is present", async () => {
    await expect(startFreshFor("/usr/local/bin/claude")).resolves.toMatchObject({
      provider: "claude-code",
    });
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});

describe("errorMiddleware", () => {
  const respond = async (err: Error) => {
    const c = { json: (body: unknown, status: number) => ({ body, status }) };
    return errorMiddleware(err, c as never) as unknown as {
      body: Record<string, unknown>;
      status: number;
    };
  };

  it("carries a thrown statusCode and code out to the client", async () => {
    const err = Object.assign(new Error("nope"), {
      statusCode: 503,
      code: "PROVIDER_NOT_INSTALLED",
    });

    expect(await respond(err)).toEqual({
      status: 503,
      body: { error: "nope", code: "PROVIDER_NOT_INSTALLED" },
    });
  });

  it("still answers 500 for an ordinary error", async () => {
    expect(await respond(new Error("boom"))).toEqual({ status: 500, body: { error: "boom" } });
  });

  // `statusCode` is a property other libraries hang on their own errors, so one
  // bubbling up from a fetch or a driver must not get to pick the response.
  it("ignores a statusCode outside the HTTP error range", async () => {
    const err = Object.assign(new Error("weird"), { statusCode: 42 });

    expect((await respond(err)).status).toBe(500);
  });
});
