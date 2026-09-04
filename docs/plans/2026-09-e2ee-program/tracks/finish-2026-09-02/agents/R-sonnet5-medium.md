# R — the negotiated rollout: one escalation and one PR that must not merge

**Model: Sonnet 5. Effort: medium.** Matching the original R brief. The hard part here is not technical; it is declining to decide something you can see an answer to.

Repo: `threadbase-streamer`, worktree `tb-streamer/.worktrees/<type>/<slug>`. You hold the streamer PR slot, and you will use it at most twice.

**R1 is already shipped** — `--no-e2ee` landed in `v1.74.0` via PR #752. Do not re-open it.

## R2 — the D-8 versus §6.5 collision

`THREADBASE_FEATURE_E2EE=0` exists by registry construction: every feature flag gets a `THREADBASE_FEATURE_*` variable automatically. That is exactly the persistent, invisible off switch dilemma **D-8** forbids for E2EE. It is harmless while the default is off, and becomes real the moment the stage-2 flip makes the default on.

`dilemmas.md` D-8 records three ways out:

1. **Exempt `e2ee` from the env rung.** Keeps D-8's rule intact. Costs the documented uniformity of the flag registry, and breaks the stage-1 enable path, which is `THREADBASE_FEATURE_E2EE=1` — the very variable this would remove.
2. **Accept the variable and drop D-8's rule as unenforceable.** Honest about what the registry already does. Costs the guarantee D-8 exists to give: that encryption cannot be turned off invisibly and persistently.
3. **Keep both, and fire the boot warning on any flag-off source**, with `/api/info`'s `reason` naming which source decided. `--no-e2ee` becomes sugar for `--feature e2ee=false`. Nothing becomes invisible, because every path announces itself.

**The reviewer's recommendation on file is option 3.** Record that as a data point. **Do not present it as your recommendation, and do not choose.** The user has not yet seen the trade-offs laid out; your job is to lay them out.

What R1 already did, and why it matters here: it implemented the **documented precedence** rather than pre-empting this decision, so `THREADBASE_FEATURE_E2EE=1 tb-streamer serve --no-e2ee` leaves encryption **on**, and there is a test pinning that behaviour (`does NOT beat the environment variable`). If the user picks option 1 or 3, that test changes as part of R2's implementation — deliberately, not as a bug fix.

**Precondition:** the owner must confirm **G-1 has landed** before you present. Draft the escalation now; hold the presentation.

**Deliverable:** a document the user can decide from in one read — the collision in three sentences, the three options with their real costs, what each one changes in code and tests, and what happens if the decision is deferred past stage 2. Then stop and hand it to the owner.

If the user picks an option that needs code, implement it as R2's PR under the usual bar. If they pick option 2, the change may be documentation only.

## R3 — the stage-2 flip

`default: false` → `default: true` for `e2ee` in `src/feature-flags.ts`. **One line.** Nothing else in the diff except the tests that pin the old default, listed in the PR body the way #674 did it.

**Open it. Never merge it.** Not on a green CI, not on an approving review, not because the owner relays enthusiasm. It merges only on the user's explicit go, in their own words, and only after:

- **G-2 has landed** — Android device evidence exists, and
- **export compliance** clears — every build since 204 ships `@stablelib` crypto under `ITSAppUsesNonExemptEncryption: false`, and that declaration is false today regardless of the flag. An E2EE-capable build cannot reach testers until the ANSSI/Apple approval lands. This is outside the program and not yours to chase; it is simply a gate.

Put a plain line in the PR body saying it merges only on the user's explicit go, so nobody merges it by reflex.

**Stage 3** — `e2ee.required: true`, refusing plaintext — is a product decision with an app-version floor, never a date and never automated. It stays an open item on issue #590 and must not appear in any diff you write.

## Standing constraints

- Strict NO-GO from the workspace `CLAUDE.md` §2, including: no protocol-constant consolidation (#619) until both implementations are proven, and no `E2EE_SUPPORTED` flip except as its own one-line PR merged last with the user's explicit go.
- One PR at a time in the streamer. Check with the owner before opening; bot PRs (dependabot, Snyk) do not hold the slot but must not be touched.
- Commit approval on the staged diff and the verbatim message. Conventional titles, one sentence per line, no AI attribution, never push to `main`.
- Rebase onto latest `main` before merging anything, and re-run every mutation after the rebase.

## Documents you keep current

The owner commits after each milestone and can only commit what exists.

- `tracks/R/PLAN-R2.md` — the escalation document itself: the collision, the three options with their real costs, what each changes in code and tests, and what deferring past stage 2 would mean.
- The user's decision, once made, recorded verbatim enough that a later session can tell what was chosen and what was merely considered.
- `tracks/R/PLAN-R3.md` or a note — the flip PR's number, its gates, and the plain statement that it merges only on the user's explicit go.

Your milestones: escalation drafted · decision recorded · R2 landed if it needs code · R3 opened. Report each.

## Stop-work

Any path that would silently downgrade a pinned device; a default that flips without the user's explicit go; stage 3 appearing in a diff; or a `dilemmas.md` entry turning out to be load-bearing for something you are changing.

## Reporting

To the owner. Report when the escalation draft is ready, when the user's decision is recorded, and when R3 is open and green. Never report R3 as "ready to merge" without the two gates named alongside it.
