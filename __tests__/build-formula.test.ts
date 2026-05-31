import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "scripts", "build-formula.mjs");

describe("build-formula.mjs", () => {
  it("renders the template with version + per-arch sha256s", () => {
    const work = mkdtempSync(join(tmpdir(), "build-formula-"));
    const artifactsDir = join(work, "release-artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-darwin-arm64.tgz"), "ARM_BODY");
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-darwin-x64.tgz"), "X64_BODY");
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-linux-x64.tgz"), "LIN_BODY");

    const outFile = join(work, "tb-streamer.rb");

    execFileSync("node", [
      SCRIPT,
      "--version",
      "9.9.9",
      "--artifacts",
      artifactsDir,
      "--out",
      outFile,
    ]);

    const rendered = readFileSync(outFile, "utf-8");
    expect(rendered).toContain('version "9.9.9"');
    expect(rendered).toContain("threadbase-streamer-9.9.9-darwin-arm64.tgz");
    expect(rendered).toContain("threadbase-streamer-9.9.9-darwin-x64.tgz");
    expect(rendered).toContain("threadbase-streamer-9.9.9-linux-x64.tgz");
    expect(rendered).not.toContain("{{");

    const armSha = createHash("sha256").update("ARM_BODY").digest("hex");
    const x64Sha = createHash("sha256").update("X64_BODY").digest("hex");
    const linSha = createHash("sha256").update("LIN_BODY").digest("hex");
    expect(rendered).toContain(armSha);
    expect(rendered).toContain(x64Sha);
    expect(rendered).toContain(linSha);
  });

  it("exits non-zero when a required artifact is missing", () => {
    const work = mkdtempSync(join(tmpdir(), "build-formula-fail-"));
    const artifactsDir = join(work, "release-artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    // Missing darwin-arm64
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-darwin-x64.tgz"), "X");
    writeFileSync(join(artifactsDir, "threadbase-streamer-9.9.9-linux-x64.tgz"), "L");

    let exitCode = 0;
    try {
      execFileSync(
        "node",
        [SCRIPT, "--version", "9.9.9", "--artifacts", artifactsDir, "--out", join(work, "out.rb")],
        { stdio: "pipe" },
      );
    } catch (err: unknown) {
      exitCode = (err as { status: number }).status;
    }
    expect(exitCode).not.toBe(0);
  });
});
