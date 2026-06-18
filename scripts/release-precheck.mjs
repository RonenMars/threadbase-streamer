#!/usr/bin/env node
// Commit-analysis-only release precheck.
//
// WHY THIS EXISTS (and why it does NOT run `semantic-release --dry-run`):
// The release-precheck job only needs to answer "is a release warranted, and
// what's the next version?". The obvious way — `semantic-release --dry-run` —
// loads ALL configured plugins and runs their `verifyConditions` first, BEFORE
// commit analysis. `@semantic-release/npm`'s verifyConditions requires an npm
// auth token, so the dry-run aborts with "No npm token specified." before ever
// printing the next-version line. That coupled a read-only decision to npm
// publish credentials and caused every push to false-negative as "no
// release-worthy commits" whenever the token was missing/expired.
//
// Instead we call ONLY `@semantic-release/commit-analyzer` — the same plugin and
// the same rules the real release uses (loaded from .releaserc.json, so there's
// no rule duplication) — with no publishing plugins, no npm/OIDC auth, and no
// git remote access. The real publish is still handled solely by the `release`
// job (via OIDC Trusted Publishing).
//
// Scope: stable channel (vX.Y.Z) only. The `next` prerelease branch still gets a
// correct should_release, but its exact `-next.N` suffix is not computed here —
// the real release job computes the authoritative version regardless.

import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import semver from "semver";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run git and return trimmed stdout. */
function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** Extract the @semantic-release/commit-analyzer options from .releaserc.json. */
function loadAnalyzerConfig() {
  const rc = JSON.parse(readFileSync(join(repoRoot, ".releaserc.json"), "utf8"));
  const entry = (rc.plugins || []).find(
    (p) => p === "@semantic-release/commit-analyzer" ||
      (Array.isArray(p) && p[0] === "@semantic-release/commit-analyzer"),
  );
  if (!entry) {
    throw new Error(".releaserc.json has no @semantic-release/commit-analyzer plugin");
  }
  // entry is either the bare string or [name, options].
  return Array.isArray(entry) ? entry[1] || {} : {};
}

/**
 * Most recent stable release tag reachable from HEAD, as a vX.Y.Z string, or
 * null if there is no prior stable release. Prerelease tags (vX.Y.Z-next.N) are
 * intentionally excluded — this precheck targets the stable channel.
 */
function lastStableTag() {
  const out = git([
    "tag",
    "--list",
    "v*",
    "--merged",
    "HEAD",
    "--sort=-v:refname",
  ]);
  if (!out) return null;
  for (const tag of out.split("\n")) {
    const version = tag.replace(/^v/, "");
    // semver.valid() rejects prerelease-suffixed tags only if we check for them
    // explicitly: it accepts 1.2.3-next.1. We want bare X.Y.Z.
    const parsed = semver.parse(version);
    if (parsed && parsed.prerelease.length === 0) return tag;
  }
  return null;
}

/** Commits since `tag` (or all history if tag is null), shaped for the analyzer. */
function commitsSince(tag) {
  // %H <newline> %B (full message) <newline> NUL-terminator, so multi-line
  // bodies survive intact and commits split cleanly on the NUL.
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const raw = git(["log", range, "--format=%H%n%B%x00"]);
  if (!raw) return [];
  return raw
    .split("\0")
    .map((chunk) => chunk.replace(/^\n/, ""))
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      const hash = nl === -1 ? chunk : chunk.slice(0, nl);
      const message = nl === -1 ? "" : chunk.slice(nl + 1).trim();
      return { hash, message };
    });
}

/** Minimal logger matching the subset of signale the analyzer uses. */
const logger = {
  log: () => {},
  error: (...args) => console.error(...args),
};

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function main() {
  const pluginConfig = loadAnalyzerConfig();
  const tag = lastStableTag();
  const baseVersion = tag ? tag.replace(/^v/, "") : "0.0.0";
  const commits = commitsSince(tag);

  const releaseType = await analyzeCommits(pluginConfig, {
    commits,
    logger,
    cwd: repoRoot,
    env: process.env,
  });

  if (!releaseType) {
    setOutput("should_release", "false");
    setOutput("next_version", "");
    console.log("ℹ️  No release-worthy commits — skipping build + publish.");
    return;
  }

  const nextVersion = semver.inc(baseVersion, releaseType);
  if (!nextVersion) {
    throw new Error(
      `Could not compute next version from base "${baseVersion}" and release type "${releaseType}"`,
    );
  }
  setOutput("should_release", "true");
  setOutput("next_version", nextVersion);
  console.log(`✅ Would release v${nextVersion} (${releaseType} from ${commits.length} commits since ${tag || "repo start"})`);
}

main().catch((err) => {
  // Non-zero exit only on real errors — never for a legitimate "no release".
  console.error("release-precheck failed:", err.message);
  process.exit(1);
});
