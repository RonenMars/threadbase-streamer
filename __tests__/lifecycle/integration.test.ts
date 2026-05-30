import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const SHIM = join(REPO_ROOT, "dist", "launchd-entry.cjs");

describe("launchd shim integration", () => {
  let dir: string;

  beforeAll(() => {
    // Ensure the shim is built.
    if (!existsSync(SHIM)) {
      execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
    }
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shim-int-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runShim(env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [SHIM, "serve", "--port", "65530", "--no-pair-qr"], {
      env: { ...process.env, THREADBASE_INSTALL_DIR: dir, ...env },
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("absent marker + missing cli.js → exits non-zero with 'active link missing'", () => {
    const result = runShim();
    expect(result.status).not.toBe(0);
    const combined = result.stdout.toString() + result.stderr.toString();
    expect(combined).toMatch(/active link missing/);
  });

  it("userHeld marker → exits 0 without trying to start cli.js", () => {
    writeFileSync(
      join(dir, "prod-suspended.json"),
      JSON.stringify({
        devPid: 1,
        port: 8766,
        repoToplevel: "/x",
        suspendedAt: "2026-05-30T19:55:00.000Z",
        userHeld: true,
        shimVersion: 1,
      }),
    );
    const result = runShim();
    expect(result.status).toBe(0);
    const combined = result.stdout.toString() + result.stderr.toString();
    expect(combined).toMatch(/user-held/);
  });

  it("stale marker (dead pid, not userHeld) → clears marker and tries to exec", () => {
    writeFileSync(
      join(dir, "prod-suspended.json"),
      JSON.stringify({
        devPid: 999999,
        port: 8766,
        repoToplevel: "/x",
        suspendedAt: "2026-05-30T19:55:00.000Z",
        userHeld: false,
        shimVersion: 1,
      }),
    );
    runShim();
    // Marker should be cleared regardless of cli.js outcome.
    expect(existsSync(join(dir, "prod-suspended.json"))).toBe(false);
  });
});
