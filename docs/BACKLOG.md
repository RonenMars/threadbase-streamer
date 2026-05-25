# Backlog — Threadbase Streamer

Loose ends and follow-ups for `@threadbase/streamer`. Self-contained enough to pick up without re-reading the original conversation.

---

## Cleanup TODO

### Scanner repo visibility (A12)

`@threadbase/scanner` is consumed as a npm git URL dep (`github:RonenMars/threadbase-scanner#<tag>`) per CLAUDE.md. The repo migration plan called for making the repo public under MIT (commits `20a6060`, `ba36685`); that landed and tag `v0.3.0` is published, but the repo visibility flip on GitHub was deferred for manual review.

**Fix:** confirm `https://github.com/RonenMars/threadbase-scanner` is public and the README clearly states MIT licensing. If still private, flip visibility in GitHub repo settings and verify a clean clone works without auth (the streamer install path depends on this for end users without a GitHub token).

### Release pipeline stalled — Actions budget exhausted

The last 3 pushes to `main` (runs `26372378887`, `26372564655`, `26373635465`, all on 2026-05-24) failed within ~3-5 s with no failed *steps* — GitHub Actions is rejecting jobs at queue time because the account is over its monthly Actions spending limit. semantic-release config itself is fine; the latest successful release was `v1.0.1` on 2026-05-23.

Two release-worthy commits are merged but unreleased:
- `fda9e2a feat: filter agent conversations from cache via entrypoint marker (#4)` — minor bump
- `93e93ff fix: backfill project context for skeleton conversation cache rows (#3)` — patch

**Fix:** top up the Actions budget (or wait for the monthly reset), then re-run the latest failed workflow on `main`. Both commits will be picked up in one `1.1.0` release.

---

## Sequencing

Nothing in this backlog is blocking. Address Scanner visibility before the next end-user-facing release announcement (otherwise `npm install` will fail for users without GitHub credentials).
