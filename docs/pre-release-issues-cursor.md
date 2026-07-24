Under an **open-source invite** lens (LinkedIn / Reddit / dev.to / Medium), most labeled Critical/High items are **maintainer release gates**, not first-user blockers.

### Recalculation verdict

Original severity optimized for “green Maestro + no core bugs.” For public invites, keep only what breaks **install → pair → browse → chat**, or creates **privacy/trust** risk.

| Still launch-critical | Demote for OSS invite | Elevate for first users |
|---|---|---|
| Privacy/crash consent | Maestro suite green | Onboarding polish |
| Stale conversation history | Typecheck Href failures | Abandoned empty sessions |
| Multi-attachment send | Hub stall on 1k+ trees | Homebrew/manual plist conflict |
| bootstrapAgent false-positive | Log truncation / Windows logs (unless Win ships) | |

### Status as of 2026-07-19

| Item | Repo | Status |
|---|---|---|
| Stale conversation history | streamer | PR [#237](https://github.com/RonenMars/threadbase-streamer/pull/237) |
| Homebrew vs deploy plist conflict | streamer | PR [#238](https://github.com/RonenMars/threadbase-streamer/pull/238) |
| `bootstrapAgent` exit-5 | streamer | PR [#240](https://github.com/RonenMars/threadbase-streamer/pull/240) |
| Upload filename sanitize (Bug 5 pair) | streamer | PR [#241](https://github.com/RonenMars/threadbase-streamer/pull/241) |
| Crash consent + privacy (Features 35/36) | mobile | PR [#343](https://github.com/RonenMars/threadbase-mobile/pull/343) |
| Multi-attachment / spaced `@path` (Bug 5) | mobile | PR [#345](https://github.com/RonenMars/threadbase-mobile/pull/345) |
| Abandoned empty sessions (Bug 16) | mobile | PR [#346](https://github.com/RonenMars/threadbase-mobile/pull/346) |
| Quick Access historical routing | both | Superseded on modern mobile; keep `/api/sessions/recents` for older clients |

### TOP 5 — tb-mobile (original ranking; #1/#3/#4 now in flight)

1. **Crash consent + privacy checklist** (Features 35 + 36) — trust before public posts → #343  
2. **Onboarding polish** (Feature 5) — first 5 minutes after a social click — still open  
3. **Multi-attachment send** (Bug 5) — broken advertised capability in demos → #345  
4. **Discard abandoned empty sessions** (Bug 16) — explorers leave ghost sessions → #346  
5. **Hub expand stall** (Issue 2) — only if launch demos use large trees; otherwise defer  

### TOP 5 — tb-streamer (original ranking; #1–#3 + upload sanitize in flight)

1. **Stale conversation history vs fresh resume** — sole true product P0 → #237  
2. **Homebrew vs manual plist conflict** — install posts will hit this → #238  
3. **`bootstrapAgent` exit-5 false-positive** — setup fails before pairing → #240  
4. **Quick Access historical routing** — superseded on modern mobile  
5. **Windows `prod logs`** — only if Windows is in invite scope; else waive  

**Safe to ship-with for this invite:** ungreen Maestro, Expo Router typecheck, log truncation, keychain migration, Codex cards, Mission Control / roadmap features.

**Live docs:** [open issues by severity](pre-release-open-issues-by-severity-2026-07-18.md) (streamer). Mobile open-items status lives in the companion `threadbase-mobile` docs PR.
