# 🚦 Pre-release Backlog and Roadmap Analysis

> 📅 **Date:** 2026-07-18 (snapshot) · **Status update:** 2026-07-19  
> 📦 **Repository:** `@threadbase/streamer`  
> 🌿 **Main commit reviewed:** `e8565ea`  
> 📚 **Sources:** [BACKLOG.md](BACKLOG.md) and [ROADMAP.md](ROADMAP.md)  
> 📌 **Live open-items view:** [pre-release-open-issues-by-severity-2026-07-18.md](pre-release-open-issues-by-severity-2026-07-18.md) (updated 2026-07-19)

---

## 🚨 Release Verdict

> 🟡 **Improved since snapshot.** Former P0 (stale conversation history) and key P1s (Homebrew conflict, `bootstrapAgent` exit-5, upload filename sanitize) are in open PRs — see the open-issues status doc. Tables below are the frozen 2026-07-18 snapshot; do not treat them as current.

No S0 critical data-loss or authentication issue was identified in these documents. This is a focused review of the documented backlog and roadmap, not a full codebase release audit.

## 🧭 Rating Scale

- **Severity:** 🚨 S0 critical, 🔴 S1 high, 🟠 S2 medium, 🟡 S3 low, 🟢 S4 enhancement.
- **Priority:** 🚨 P0 release blocker, 🔴 P1 pre-release, 🟡 P2 post-release, 🔵 P3 defer.
- **Effort:** ⚡ XS less than 1 day, 🔹 S 1-2 days, 🔸 M 3-5 days, 🔷 L 1-2 weeks.
- **Age:** ⏳ Time since the first explicit report date, or the Git introduction date when no report date was present.

## 📋 Analysis

| Task / issue | Estimated severity | Estimated priority | Estimated effort | Already implemented on main? | Age | Type |
|---|---:|---:|---:|---|---:|---|
| Stale conversation history vs. fresh resume | 🔴 S1 | 🚨 **P0** | 🔸 M | ⚠️ **Partial:** directory watcher exists, but normal cached listing does not reconcile | 48d | 🐛 Bug |
| Log truncation creates sparse/NUL-filled logs | 🟠 S2 | 🔴 P1 | 🔹 S | ⚠️ **Partial:** deploy preserves logs by default; explicit clear still races open file descriptors | 46d | 🐛 Bug |
| Busy-wait CPU spin in `bootoutAgent` | 🟡 S3 | 🟡 P2 | ⚡ XS | ❌ No | 46d | 🐛 Bug |
| `bootstrapAgent` exit-5 false-positive | 🟠 S2 | 🔴 P1 | 🔹 S | ❌ No | 46d | 🐛 Bug |
| Partial `prod logs --clear` failure | 🟡 S3 | 🟡 P2 | ⚡ XS | ❌ No | 46d | 🐛 Bug |
| Quick Access historical conversation routing | 🟠 S2 | 🔴 P1 | 🔹 S | ❌ No in streamer; 📱 mobile-owned | 39d | 🐛 Bug |
| Migrate `/api/search` to QUERY | 🟢 S4 | 🔵 P3 | 🔸 M | ❌ No; ✅ GET remains | 6d | 🛠️ Task |
| Store API key in OS keychain | 🟠 S2 security | 🟡 P2 | 🔷 L | ❌ No; YAML plus `0600` remains | 47d | 🛠️ Task |
| Homebrew/manual plist conflict check | 🟠 S2 | 🔴 P1 | 🔹 S | ❌ No; related label detection exists, not conflict prevention | 47d | 🛠️ Task |
| Forward `thinkingSignature` | 🟢 S4 | 🔵 P3 cleanup | ⚡ XS | ✅ **Yes:** already mapped as `signature` | 47d, stale | 🛠️ Task |
| Forward `sourceToolAssistantUUID` | 🟢 S4 | 🔵 P3 | ⚡ XS | ❌ No | 47d | 🛠️ Task |
| Forward full `SystemEntry` types | 🟢 S4 | 🔵 P3 | 🔹 S | ❌ No | 47d | 🛠️ Task |
| Forward per-image metadata | 🟢 S4 | 🔵 P3 | 🔸 M | ❌ No; only `has_images` is forwarded | 47d | 🛠️ Task |
| Windows `prod logs` | 🟠 S2 | 🔴 P1 if Windows ships | 🔸 M | ❌ No; command remains advertised but throws | 46d | 🛠️ Task |
| Normalize Commander booleans | 🟡 S3 | 🔵 P3 | ⚡ XS | ❌ No | 46d | 🧹 Maintenance |
| Codex structured prompt cards | 🟠 S2 | 🟡 P2 | 🔸 M | ⚠️ **Partial:** trust/hooks startup gates only; general approvals/questions remain | 13d | 🛠️ Task |
| Fully incremental warm-up | 🟡 S3 | 🟡 P2 | 🔷 L | ⚠️ **Partial:** scanner layer is incremental; streamer reconcile/tails are not | 5d | 🧹 Maintenance |
| Split `src/server.ts` | 🟡 S3 | 🟡 P2 | 🔷 L | ❌ No; handler bodies remain in the 3,635-line class | 6d | 🧹 Maintenance |

## ✅ Required Before Release

- [ ] 🚨 **Fix the P0:** regression-test stale history for external JSONL additions and appends without requiring `?refresh=1`.
- [ ] 🔴 **Resolve or waive P1 issues:** log clearing, bootstrap verification, Homebrew conflict detection, and Windows logs if Windows is in release scope.
- [ ] 📱 **Coordinate the Quick Access fix in `tb-mobile`:** changing or removing `/api/sessions/recents` server-side would break older clients.
- [ ] 🔒 **Preserve compatibility:** do not replace `GET /api/search` with QUERY. Any future migration must retain GET alongside QUERY.

## 🔍 Main-branch Findings

- Conversation directory watching is implemented, but the normal cached `/api/conversations` path still returns without reconciling a stale scanner. The stale-history bug is therefore only partially addressed.
- Deploys preserve logs by default as of `3e38579`, reducing exposure to the truncation race. Explicit `--clear-logs` and `prod logs --clear` still truncate files while writers may hold old offsets.
- `bootoutAgent` still contains the 50 ms tight spin loop.
- `bootstrapAgent` still accepts exit 5 with empty stderr when any matching label is loaded.
- `thinkingSignature` is already forwarded as `signature` in the thinking content block. Its roadmap entry is stale.
- Codex startup trust and hooks-review gates now produce permission cards. General Codex approval and multi-choice question detection remains unimplemented.
- Windows `prod logs` still throws from `getLogPaths()`, while the command remains registered.
- `/api/search` remains a GET endpoint, which preserves existing mobile compatibility.

## 🧹 Documentation Cleanup

- Remove the completed `thinkingSignature` roadmap entry.
- Narrow the Codex prompt-card entry to the remaining non-startup approval and question flows.
- Update the log-truncation backlog item to note that default deploys now preserve logs, while explicit clearing remains affected.

## ✅ Verification

The checkout was clean and local `main` matched `origin/main` at `e8565ea` during the review.

Focused tests passed:

- ✅ `__tests__/conversation-watcher.test.ts`
- ✅ `__tests__/lifecycle/launchd.test.ts`
- ✅ `__tests__/lifecycle/prod-commands.test.ts`
- ✅ `__tests__/codex-pty-runner.test.ts`

> ✅ **Result:** 4 test files passed, 63 tests passed.  
> ℹ️ The full lint and test suites were not run for this documentation review.
