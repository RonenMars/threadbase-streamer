# Releasing

Two channels, both cut by semantic-release from `.github/workflows/release.yml`.

| Channel | Branch | Version | npm dist-tag | GitHub Release | Homebrew |
| ------- | ------ | ------- | ------------ | -------------- | -------- |
| stable  | `main` | `1.114.0` | `latest` | release | updated |
| next    | `next` | `1.115.0-next.1` | `next` | prerelease | untouched |

Versions come from conventional-commit titles: `feat:` → minor, `fix:` → patch,
`BREAKING CHANGE:` → major. `docs:`, `test:`, `chore:`, `build:`, `ci:` cut no
release. Every release also pushes a `chore(release): X [skip ci]` commit back to
the branch, so a `feat:`/`fix:` merge moves the branch twice.

## The `next` channel

`next` is where a change soaks before it reaches everybody. Relay-by-default
lives there first.

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

## Bump on release

A repo the streamer depends on tells it when it ships. The streamer then opens a
PR that bumps its pin and lets auto-merge land it once CI is green. Every flow
has the same two halves.

| Producer | Event | Streamer workflow | Bumps | PR base |
| -------- | ----- | ----------------- | ----- | ------- |
| scanner | `scanner-released` | `update-scanner.yml` | `@threadbase-sh/scanner` | `main` |
| agent-types | `agent-types-released` | `update-agent-types.yml` | `@threadbase-sh/agent-types` | `main` |
| menubar | `menubar-released` | `update-menubar.yml` | `vendor/menubar` submodule pointer | `main` |
| relay | `relay-released` | `update-relay.yml` | `HOSTED_RELAY_PUBLIC_KEY` in `src/relay/hosted.ts` | `next` |

**Producer half.** A `notify-streamer.yml` runs on a `v*` tag push and sends
`repository_dispatch` to this repo with `client_payload.tag`. The default
`GITHUB_TOKEN` cannot dispatch across repositories, so the producer holds a PAT
secret `STREAMER_DISPATCH_PAT`.

**Streamer half.** Each `update-*.yml` also runs by hand (`workflow_dispatch`).
Its PAT secret (`SCANNER_VER_BUMP_PAT`, `RELAY_VER_BUMP_PAT`, …) matters: a PR
opened with the default token does not trigger CI, so auto-merge would never see
required checks pass. The payload is attacker-controllable, so each workflow
checks its shape before it reaches `npm`, `sed`, `git` or `gh`.

### The relay is different

The streamer has no relay package. What a relay release can change here is the
public key the streamer pins, because a streamer with a stale key cannot open its
tunnel (see [remote access](remote-access/README.md)). So:

- the dispatch carries the key as well as the tag
  (`client_payload.public_key`, 43 base64url characters);
- `update-relay.yml` rewrites `HOSTED_RELAY_PUBLIC_KEY` and opens the PR against
  `next`, not `main`, since relay-by-default ships through the prerelease channel
  first;
- a release that keeps the key ends with "nothing to do" and opens no PR.

Run it by hand after rotating the key:

```bash
gh workflow run update-relay.yml -f public_key=<43-char key> -f tag=v0.2.0
```

The key is pinned and the relay holds one key at a time (`RELAY_STATIC_KEY`), so
there is no overlap window: a streamer on the old key cannot reach a relay on the
new one, and the reverse. Release the streamer carrying the new key first, then
switch the relay; streamers that have not updated are cut off until they do.
