import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SHIM_SCRIPT = join(__dirname, "..", "scripts", "lib", "install-shim.sh");

// Runs a small bash snippet that sources install-shim.sh and invokes one of its
// `_shim_*` helpers with a controlled PATH. Returns { code, stdout, stderr }.
function runBash(args: {
  pathDir: string;
  cliPath: string;
  helper: string; // e.g. "_shim_existing_symlink_matches"
}): { code: number; stdout: string; stderr: string } {
  const script = `
set -u
PATH='${args.pathDir}:/usr/bin:/bin'
source '${SHIM_SCRIPT}'
${args.helper} '${args.cliPath}'
`;
  try {
    const stdout = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

// Unix-only: sources install-shim.sh under bash and creates symlinks. On
// Windows symlinkSync needs admin/Developer Mode (EPERM) and the shim mechanism
// is .cmd wrappers, not symlinks — so this bash-script behavior doesn't apply.
describe.skipIf(process.platform === "win32")("install-shim.sh idempotency check", () => {
  let workDir: string;
  let cliPath: string;
  let binDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tb-shim-test-"));
    cliPath = join(workDir, "cli.js");
    binDir = join(workDir, "bin");
    writeFileSync(cliPath, "#!/usr/bin/env node\n");
    chmodSync(cliPath, 0o755);
    // Need to create the bin dir before symlinking into it.
    execFileSync("mkdir", ["-p", binDir]);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns success only when EVERY configured name resolves to cli_path", () => {
    // Only install the entrenched name, leave `tb-streamer` missing — this is
    // the exact state of a user who installed before the short alias existed.
    symlinkSync(cliPath, join(binDir, "threadbase-streamer"));

    const result = runBash({
      pathDir: binDir,
      cliPath,
      helper: "_shim_existing_symlink_matches",
    });

    // Bug semantics: a partial match (one of two names present) must NOT
    // short-circuit the install — otherwise the missing alias never lands.
    expect(result.code).toBe(1);
  });

  it("returns success when ALL configured names resolve to cli_path", () => {
    symlinkSync(cliPath, join(binDir, "threadbase-streamer"));
    symlinkSync(cliPath, join(binDir, "tb-streamer"));

    const result = runBash({
      pathDir: binDir,
      cliPath,
      helper: "_shim_existing_symlink_matches",
    });

    expect(result.code).toBe(0);
    // The function prints the path of the matched shim on stdout.
    expect(result.stdout).toContain("threadbase-streamer");
  });

  it("returns failure when no configured name exists on PATH", () => {
    const result = runBash({
      pathDir: binDir,
      cliPath,
      helper: "_shim_existing_symlink_matches",
    });

    expect(result.code).toBe(1);
  });
});
