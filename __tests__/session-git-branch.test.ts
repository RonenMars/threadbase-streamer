import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock("../src/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform")>()),
  locateProviderExe: () => "/usr/local/bin/claude",
}));

/**
 * No client sends `branch` on start, so every managed session persisted '' —
 * 137 of 137 rows in a real runtime.db. The streamer reads it from the
 * project's checkout instead.
 */
describe("managed session branch", () => {
  const repo = mkdtempSync(join(tmpdir(), "tb-branch-repo-"));
  const plain = mkdtempSync(join(tmpdir(), "tb-branch-plain-"));

  beforeAll(() => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-b", "feat/probe");
    // An unborn branch has no HEAD to rev-parse; give it one commit.
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "x",
    );
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  const manager = async () =>
    new (await import("../src/live-session-manager")).LiveSessionManager();

  it("reads the branch for a fresh session", async () => {
    const lsm = await manager();
    const session = await lsm.startFresh({ provider: "claude-code", projectPath: repo });
    expect(session.branch).toBe("feat/probe");
    lsm.dispose();
  });

  it("reads the branch for a resumed session", async () => {
    const lsm = await manager();
    const session = await lsm.start("11111111-1111-4111-8111-111111111111", {
      provider: "claude-code",
      projectPath: repo,
    });
    expect(session.branch).toBe("feat/probe");
    lsm.dispose();
  });

  it("keeps a branch the caller supplied", async () => {
    const lsm = await manager();
    const session = await lsm.startFresh({
      provider: "claude-code",
      projectPath: repo,
      branch: "from-client",
    });
    expect(session.branch).toBe("from-client");
    lsm.dispose();
  });

  it("leaves it empty outside a git checkout", async () => {
    const lsm = await manager();
    const session = await lsm.startFresh({ provider: "claude-code", projectPath: plain });
    expect(session.branch).toBe("");
    lsm.dispose();
  });
});
