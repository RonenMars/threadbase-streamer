# D1 report — device evidence, pairing gates

Group D, session `e2ee-D-sonnet5-medium`. Full runbook and row-by-row evidence: `PLAN-D.md`. This is the summary.

## Result: all 7 rows PASS

| Row | What | Result |
|---|---|---|
| 1 | Disabled server (`e2ee=false`) prints QR with no `spk`/`v`; legacy pairing succeeds | PASS |
| 2 | Malformed `spk`, wrong responder key, missing msg2, tampered msg2 — each fails visibly, adds no server | PASS (4/4) |
| 3 | Deep-link/paste confirmation gate: fingerprint + machine name; cancel adds nothing; confirm adds | PASS |
| 4 | Identity code renders LTR in `he` and `ar` | PASS (2/2) |
| 5 | `publicUrl: null` over LAN | PASS |
| 6 | Key/pin restart survival; same-row re-pair; revoke-then-re-pair | PASS (restart survival, streamer#744 self-heal control); revoke-then-re-pair recovery found **unreachable from the app UI** — filed, not a stop |
| 7 | Web build: spk refused, no `D_priv` in localStorage, legacy still pairs | PASS (3/3) |

Hardware: cabled physical iPhone 17 Pro for rows 1–6, Mac browser (Chrome, Expo web) for row 7. Streamer pinned `@threadbase-sh/streamer@1.70.6` exact throughout, per D1's precondition (record layer merged but untagged at this pin — D1 exercises pairing only, which 1.70.6 fully carries). Mobile pinned `origin/main` at `92033156` (≥ required `f3e82287`).

## Issues filed

- **streamer#744** — hygiene: a lost/corrupted `msg2` leaves a fully-privileged, unrevoked device row server-side that the client never learns about; self-heals only if the same phone later retries the exact same URL. Not a stop — narrower than it first looked (traced with the owner; the app's `D_priv` handling is correct, the two orphan rows found in testing came from two different test URLs, not a key-reuse bug).
- **mobile#920** — design.md §4.4's revoke-then-re-pair recovery (server-side `repairStmt` clears `revoked_at` on a matching `e2ee_static_pub`) is unreachable from the app: `removeServer`/`editServer` both wipe `D_priv`, and re-scanning an already-known URL is blocked regardless of revoked state. No re-authorize affordance exists. Reproduced on hardware.
- **mobile#921** — `package.json` on `origin/main` pins `react@19.2.3` / `react-dom@19.2.8` (mismatched patch versions), breaking the web target entirely. Pre-existing, unrelated to E2EE; presumably never caught because web isn't exercised by the normal CI/device paths. Worked around locally (scratch-only `npm install --no-save`) to complete row 7.

## Notable non-findings (investigated, closed)

- Row-1's server briefly vanishing from the app's local list, and a background-task concurrency limit in this harness that killed 3-way-concurrent tool-tracked processes — both chased down and closed as non-issues (full detail in `PLAN-D.md` §§11–12). Neither reflects on the product.
- The row-2 "two orphan device rows with different keys" finding was traced to two different test URLs (proxy ports), not an app-side `D_priv` reuse bug — see streamer#744 above.

## Scope discipline

No code changes to either repo. `PLAN-D.md` §13 has full row-by-row evidence, commands, and screenshots (`tracks/D/evidence/`). Scratch-only test infrastructure (`exchange-proxy.js`, second/third isolated rigs, the `react-dom` workaround) never left the scratchpad or the scratch worktree; confirmed via `git status` on the mobile worktree (only `ios/Podfile.lock`, from `pod install`, unrelated to any of this).

## Teardown

All session-started processes killed and confirmed gone: rig streamers (ports 8790/8791/8794/8795, several relaunches), two test proxies (8792/8793), the device build's Metro (8081), the web build (8082), and one leaked tunnel from an early rig-isolation experiment (found and killed during final teardown — see `PLAN-D.md` §"teardown"). Confirmed against the start-of-session record: the pre-existing production streamer (`~/.threadbase`, port 8766) and both pre-existing `cloudflared` tunnels are untouched and still running; the Android emulator and any pre-existing iOS simulators are untouched. Physical iPhone can be disconnected (already told the user this after row 7 started).

## Gate

D1 accepted by `e2ee-owner` → no direct successor per the plan (X-client's own preconditions are F and the streamer tags, not D). D2 (sealed transport) is the next phase for this track, fires on X-client merge, needs the phone cabled again.
