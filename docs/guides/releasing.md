# Releasing

Two channels, both cut by semantic-release from `.github/workflows/release.yml`.

| Channel | Branch | Version | npm dist-tag | GitHub Release | Homebrew |
| ------- | ------ | ------- | ------------ | -------------- | -------- |
| stable  | `main` | `X.Y.Z` | `latest` | release | updated |
| next    | `next` | `X.Y.Z-next.N` | `next` | prerelease | untouched |

Versions come from conventional-commit titles: `feat:` → minor, `fix:` → patch,
`BREAKING CHANGE:` → major. `docs:`, `test:`, `chore:`, `build:`, `ci:` cut no
release. Every release also pushes a `chore(release): X [skip ci]` commit back to
the branch, so a `feat:`/`fix:` merge moves the branch twice.

## The `next` channel

`next` is where a change soaks before it reaches everybody.

**Cut a prerelease.** Open the PR against `next` instead of `main` and merge it
once CI is green. `release.yml` publishes `X.Y.Z-next.N` to npm under the `next`
dist-tag and to GitHub as a prerelease. Nothing else is needed; the branch exists
and `.releaserc.json` already lists it:

```json
"branches": ["main", { "name": "next", "prerelease": true }]
```

**Install it.**

```bash
npm install -g @threadbase-sh/streamer@next      # one-off
```

or let the updater follow it: set `channel: next` in `~/.threadbase/update.yaml`
(`channel: stable` is the default and skips prereleases). `tb-streamer update`
then takes the newest prerelease.

**Keep `next` ahead of `main`.** `next` is not protected (the ruleset covers the
default branch only) and CI runs on every pull request, but on `push` only for
`main` and `integration/**`. After each stable release, fast-forward `next` to
`main` through a PR so `next` never trails the stable line.

**Promote.** Merge `next` into `main` through a PR. semantic-release then cuts the
stable version with everything `next` carried.

**Roll back.** There is no automation. See *Rollback* in
[auto-update.md](auto-update.md#releases).
