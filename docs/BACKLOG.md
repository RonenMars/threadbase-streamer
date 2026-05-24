# Backlog — Threadbase Streamer

Loose ends and follow-ups for `@threadbase/streamer`. Self-contained enough to pick up without re-reading the original conversation.

---

## Cleanup TODO

### Scanner repo visibility (A12)

`@threadbase/scanner` is consumed as a npm git URL dep (`github:RonenMars/threadbase-scanner#<tag>`) per CLAUDE.md. The repo migration plan called for making the repo public under MIT (commits `20a6060`, `ba36685`); that landed and tag `v0.3.0` is published, but the repo visibility flip on GitHub was deferred for manual review.

**Fix:** confirm `https://github.com/RonenMars/threadbase-scanner` is public and the README clearly states MIT licensing. If still private, flip visibility in GitHub repo settings and verify a clean clone works without auth (the streamer install path depends on this for end users without a GitHub token).

---

## Sequencing

Nothing in this backlog is blocking. Address Scanner visibility before the next end-user-facing release announcement (otherwise `npm install` will fail for users without GitHub credentials).
