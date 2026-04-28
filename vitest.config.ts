import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const sha = git("rev-parse", "--short", "HEAD") || "unknown";
const version = `${pkg.version}+${sha}-test`;

export default defineConfig({
  define: { __VERSION__: JSON.stringify(version) },
  test: {
    globals: true,
    include: ["__tests__/**/*.test.ts"],
  },
});
