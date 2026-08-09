import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const deployScript = readFileSync(resolve(import.meta.dirname, "../scripts/deploy.ps1"), "utf8");

describe("Windows deploy script", () => {
  it("skips the npm registry check for force deployments", () => {
    expect(deployScript).toContain("[switch]$SkipVersionCheck");
    expect(deployScript).toContain("if ($SkipVersionCheck -or $Force)");
  });

  it("bounds the visible npm registry check", () => {
    expect(deployScript).toContain("checking npm for a newer published version (5s timeout)");
    expect(deployScript).toContain("--fetch-timeout=5000 --fetch-retries=0");
  });
});
