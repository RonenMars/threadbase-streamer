
## 00:02 | docs/live-activities-prompt
Analyzed APNS_KEY env var loading; determined dotenv unused in codebase; recommended `~/.threadbase/AuthKey_BX4B6855WV.p8` + export pattern; user placed key file and requested monitoring (prod instance on 8766 left running, planned throwaway test instance on spare port).
## 00:13 | integration/missing-prs-2026-07-23
Fixed OSC 777 conflation bug stranding 11 sessions on phantom permission gates; added model/effort/permissionMode to GET /api/sessions/:id; deployed prod w/ OSC discriminator + status-line parser + per-server flags; mobile: counter-line filtering + thinking skeleton + docs corrections (4 PRs cherry-picked to integration-merge-354-355-376).
## 00:23 | docs/live-activities-prompt
Implemented live-activity push end-to-end (3 PRs: token schema + kind, APNs sender w/ ES256 JWT, 8h renewal scheduler); verified against real APNs infra (BadDeviceToken confirms signing); wired APNS_KEY from ~/.threadbase/ into launchd entry; added *.p8 to .gitignore; pre-existing CI lint gate blocks merge (#292/#293/#294 stacked, locally green).