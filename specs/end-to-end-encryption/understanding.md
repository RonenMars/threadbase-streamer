# End-to-end encryption — Understanding and scope

**Status:** Approved for implementation 2026-08-14 — see [plan.md](./plan.md), tracked in [threadbase-streamer#590](https://github.com/RonenMars/threadbase-streamer/issues/590) and [threadbase-mobile#698](https://github.com/RonenMars/threadbase-mobile/issues/698).

## What this feature is

Threadbase E2EE will provide authenticated application-layer encryption between each paired mobile device and the trusted Streamer endpoint, independent of TLS or Cloudflare, and encrypt every sensitive Streamer-controlled local copy, including SQLite databases, WAL/SHM files, backups, histories, uploads, and logs. The Streamer host, Claude/Codex processes, and model provider remain trusted plaintext endpoints; provider-owned histories require encrypted-volume or provider coordination. E2EE will be the default mode, with an explicit startup-only opt-out flag—provisionally `--no-e2ee`—that emits a prominent warning and is reported to clients through server capabilities. Rollout will be staged to avoid silently breaking released mobile clients while preventing protocol downgrades for E2EE-capable pairings. The design package will contain the Streamer design and implementation plan plus separate `mobile-design.md` and `mobile-implementation-plan.md` documents covering the required mobile changes.

> Source: user-approved requirements from the E2EE design discussion on 2026-08-14, including protection for direct LAN `http://` and `ws://` connections.
