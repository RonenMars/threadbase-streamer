import { execFileSync } from "node:child_process";

export function readBuildInfo(cwd = process.cwd()): { commit: string; branch: string; dirty: boolean } | null {
  const git = process.platform === "darwin" ? "/opt/homebrew/bin/git" : "git";
  const read = (args: string[]) => execFileSync(git, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    return {
      commit: read(["rev-parse", "HEAD"]),
      branch: process.env.GITHUB_REF_NAME ?? read(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: Boolean(read(["status", "--porcelain"])),
    };
  } catch {
    // Docker and source archives may have no Git history. Unknown is explicit.
    return null;
  }
}
