import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBuildInfo } from "../scripts/build-provenance";

it("returns unknown provenance for Docker's unborn repository rather than failing the build", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-build-"));
  const git = process.platform === "darwin" ? "/opt/homebrew/bin/git" : "git";
  try {
    execFileSync(git, ["init", "-q", dir]);
    expect(readBuildInfo(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("captures the exact source commit and reports checkout state", () => {
  const info = readBuildInfo();
  expect(info?.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(info?.dirty).toBeTypeOf("boolean");
});

it("includes the build configuration's local imports in the Docker builder", () => {
  const root = resolve(import.meta.dirname, "..");
  const config = readFileSync(join(root, "tsup.config.ts"), "utf8");
  const docker = readFileSync(join(root, "docker/Dockerfile"), "utf8");
  for (const match of config.matchAll(/from "\.\/(.*?)"/g)) {
    expect(
      docker
        .split("\n")
        .some((line) => line.startsWith("COPY ") && line.includes(`${match[1]}.ts`)),
    ).toBe(true);
  }
});
