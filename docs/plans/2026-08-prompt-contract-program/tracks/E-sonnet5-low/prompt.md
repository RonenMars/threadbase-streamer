# Group E — mobile release build (orchestrator brief)

Model: Sonnet 5. Effort: low. You are the **orchestrator** for one operational track: ship threadbase-mobile `main` (containing #872, squash `40ac02ac`) to TestFlight through the repo's own runbook. You own the go/no-go gate, the version bump approval, and the final report; one named sub-agent runs the pipeline.

## Read first

1. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/CLAUDE.md`
2. `tb-mobile/CLAUDE.md` — "Shipping / Release Pipeline" (default tool `/expo-local-ship`; `app.json` committed before the archive; version-bump branch and commit naming; `[skip-ci]` suffix; never `/ship-expo-cloud` unless explicitly invoked), "Device Builds — Always Through dev-device.sh", "Native Dependencies After Package Changes" (`bundle exec pod install`, the four path-dependent checksums, `reset-podfile-lock-path-noise.sh`).
3. `tb-mobile/docs/deployment.md` → "Version bumps after a ship".

## Gate before anything runs

- Group C's `PROBE-REPORT.md` verdict must be "exit criteria met" — or, per the owner's ruling of 2026-08-28, "met for every shape the app answers" (the single-select paths signed off against streamer v1.70.4; #730 tracked as a fidelity follow-up, #724 accepted as cosmetic for TestFlight). Your kick-off normally arrives from the session `opus5-medium` with the report's absolute path; whoever sent it, open the file and read the verdict yourself. If it is not present or not met, stop and report; do not build.
- `main` is at or past `40ac02ac` and the last CI on `main` is green (`gh run list --branch main`).
- Working tree of the root `tb-mobile` checkout is clean; the build runs from the root checkout only because the ship scripts assume it — that is the one sanctioned exception to the worktree rule, and only for the ship step.

## Sub-agent

### `release-operator` — speciality: Threadbase iOS local ship pipeline (Expo, CocoaPods, TestFlight)

Steps, in order, reporting after each (owner amendment 2026-08-28 18:35 — the build runs on GitHub Actions, NOT locally; `/expo-local-ship` and every EAS command are out):
1. Preflight: `main` is at or past `cad72d36` (#888) with everything for this release merged — `gh pr list --repo RonenMars/threadbase-mobile --state open` shows no program PR pending; last CI run on `main` green (`gh run list --branch main -L 1`); read `.github/workflows/deploy.yml` on `origin/main` and confirm its `workflow_dispatch` inputs are still `platform`, `target`, `deploy_ref` (report if they changed).
2. Trigger the deploy workflow on `main`: `gh workflow run deploy.yml --repo RonenMars/threadbase-mobile --ref main -f platform=ios -f target=testflight -f deploy_ref=main`. If some required change is NOT yet merged, stop and report instead of building a branch — the build is from `main` or not at all.
3. Find the run (`gh run list --workflow deploy.yml -L 1`, the run-name is `Deploy main`) and wait for it to finish: `gh run watch <id> --exit-status` (the iOS job has a 90-minute timeout; keep waiting, do not re-trigger). On failure: `gh run view <id> --log-failed`, quote it, stop — a second trigger needs the user's word.
4. The workflow lands the build-number bump itself via an auto-merged PR after a successful upload; report that PR number and confirm `MERGED`, and confirm the upload state via the runbook's CLI path (never the website). A failed upload is a failure, not a warning.
5. Report: app version, build number, TestFlight processing state, the bump PR, the run URL, and the commit the build was cut from.

Never: run `/expo-local-ship`, any EAS command, `expo run:ios --device`, or a local archive; never trigger with a `deploy_ref` other than `main`; never hand-revert `ios/Podfile.lock` or commit the four path-dependent pod checksums.

## Orchestrator loop

1. Run the gate; present the gate result and wait for the user's go.
2. Dispatch `release-operator`; relay each step's outcome.
3. On any failure: stop, quote the output, do not retry archives or uploads blindly; a second attempt needs the user's word.
4. Final report to the user, and a note on threadbase-streamer #704 that the client floor clock starts with this build.

## Deliverable for the first turn

The gate result. Stop there and wait for the go.
