# Decouple release precheck from npm — design

**Date:** 2026-06-18
**Status:** approved (brainstorming)
**Branch:** `ci/npm-trusted-publishing` (folded into PR #109)

## Problem

The `release-precheck` job runs `npx semantic-release --dry-run` purely to decide
whether a release is needed. That loads `@semantic-release/npm`, whose
`verifyConditions` requires `NODE_AUTH_TOKEN` even though the precheck publishes
nothing. This couples a read-only decision job to npm publishing credentials, and
was the root cause of the "every push false-negatives as no release-worthy commits"
bug: a missing/expired npm token aborted the dry-run before commit analysis.

Combined with PR #109 (OIDC Trusted Publishing for the real publish), removing this
coupling lets us delete the `NPM_TOKEN` secret entirely — no token anywhere in the
release pipeline.

## Approach

A standalone `scripts/release-precheck.mjs` that uses semantic-release's **real**
commit analyzer with the **real** rules from `.releaserc.json`, but loads no
publishing plugins and contacts neither npm nor the git remote.

Chosen over reusing `semantic-release/lib/get-config.js` because that loads and
verifies *all* plugins (including `@semantic-release/npm`), reintroducing the exact
coupling we are removing.

Scope: **stable channel (`main`) only** — exact `vX.Y.Z` bump. The `next` prerelease
branch still gets a correct `should_release`, but `next_version`'s `-next.N` suffix
is not computed (the real release job computes the authoritative version anyway).

## `scripts/release-precheck.mjs`

1. **Load rules** — `JSON.parse(.releaserc.json)`, find the
   `@semantic-release/commit-analyzer` plugin entry, extract its options
   (`preset`, `releaseRules`). Single source of truth; no rule duplication.
2. **Last stable tag** — `git tag --list 'v*' --merged HEAD --sort=-v:refname`,
   keep only bare `vX.Y.Z` (reject prerelease suffixes), take the first. None →
   first release, base `0.0.0`.
3. **Commits since tag** — `git log <tag>..HEAD` parsed into
   `{hash, message, subject, body}` as the analyzer expects.
4. **Analyze** — `import { analyzeCommits } from '@semantic-release/commit-analyzer'`;
   call `analyzeCommits(pluginConfig, { commits, logger, cwd, env })` →
   `null | 'patch' | 'minor' | 'major'`.
5. **Outputs** — `null` → `should_release=false`, `next_version=`. Otherwise
   `should_release=true`, `next_version = semver.inc(lastVersion, type)`.
6. **Emit** — append to `$GITHUB_OUTPUT` when set; always echo a human line.
   Locally (no `$GITHUB_OUTPUT`) just prints.
7. **Exit** — `0` for both release decisions; non-zero only on real errors
   (git failure, bad config, analyzer throw).

**Deps:** `@semantic-release/commit-analyzer` (promoted to explicit devDep),
`semver` (already present). No npm/OIDC/auth.

## Workflow change (`release-precheck` job)

- Drop `NODE_AUTH_TOKEN` and `registry-url` (no npm contact).
- Lower permission to `contents: read` (no git-push probe anymore).
- Replace the `npx semantic-release --dry-run | grep` block with
  `node scripts/release-precheck.mjs`.
- Keep outputs `should_release` / `next_version` — build/release gating unchanged.
- Comment explaining why precheck no longer uses `semantic-release --dry-run`.

The `build` and `release` jobs are untouched; the real release stays the sole
publisher (via OIDC, per PR #109).

## Testing — `__tests__/release-precheck.test.ts`

Temp git repo per case, run the script as a child process with a clean env:

- tag `v1.0.0` + `fix:` commit → `should_release=true`, `next_version=1.0.1`.
- `feat:` commit → `1.1.0`.
- breaking change (`feat!:`) → `2.0.0`.
- `chore:` / `docs:` only → `should_release=false`, `next_version=` empty.
- run with **no `NPM_TOKEN`/`NODE_AUTH_TOKEN`** in env → still works.
- `$GITHUB_OUTPUT` set → asserts the file receives the expected `key=value` lines.

## Outcome

`NPM_TOKEN` is no longer referenced anywhere in `release.yml`:

- **Precheck** uses `scripts/release-precheck.mjs` — no npm auth.
- **Release** publishes via OIDC Trusted Publishing (`id-token: write`, no
  `NODE_AUTH_TOKEN`) — folded in from the same PR (#109).

Once the trusted publisher is configured on npmjs.com, the `NPM_TOKEN` secret can
be deleted and the rotation reminders dropped — there is no token anywhere in the
release pipeline.
