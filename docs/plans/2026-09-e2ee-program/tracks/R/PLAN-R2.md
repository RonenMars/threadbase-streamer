# PLAN-R2 — the D-8 vs §6.5 escalation

Status: **DRAFTED, NOT YET PRESENTED.** Presentation is held on the owner's confirmation that **G-1** (continuation frames, on hardware) has landed — per the R task brief, drafting is unblocked but presenting is not. As of this draft (2026-09-02), `tracks/STATUS.md` still lists G-1 as open and blocking R2.

Pinned against streamer `origin/main` = `d9148f25` (`v1.74.0` = `67f2d05e`, R1 shipped via PR #752). Every file/line/test cited below was read from `origin/main` at that commit, not assumed from an earlier plan.

This document decides nothing. It exists so you can decide in one read.

---

## The collision, in three sentences

Every entry in the feature-flag registry gets a `THREADBASE_FEATURE_<ID>` environment variable automatically (`src/feature-flags.ts`) — for `e2ee` that variable is `THREADBASE_FEATURE_E2EE`, and it is also the *documented* way to turn E2EE on today (`src/api/routes/misc.routes.ts:216-218`). Dilemma **D-8** (`specs/end-to-end-encryption/dilemmas.md:169-189`) says the operator's decision to run *this* boot in plaintext must never be persistent or invisible — but that env var is exactly that: set it once on a supervised box (launchd/systemd/Task Scheduler) and it silently keeps every future boot in plaintext, forever, with no warning today. It is harmless while `e2ee` defaults **off** (turning it "off" via env changes nothing), and becomes a real, live downgrade path the moment stage 2 flips the default to **on**.

## This already exists, and it is already silent — today, not at stage 2

The instinct is to read this as a future risk stage 2 would create. It isn't. Right now, on `origin/main`, at `e2ee`'s current `default: false`:

- The boot warning that exists today fires **only when the flag was disabled from the CLI rung**: `if (this.featureFlags.e2ee || this.featureFlagSources.e2ee !== "cli") return;` (`src/server.ts:2404`). Set `e2ee` off via `THREADBASE_FEATURE_E2EE=0`, a `server.yaml` line, or leave it at the plain registry default, and **no warning fires, at any stage, today.**
- `/api/info`'s `reason` field has the identical asymmetry: `disabledReason()` (`src/api/routes/misc.routes.ts:205-211`) names the specific cause only for `source === "cli"`. Every other source — env, yaml, or default — collapses into one generic line that doesn't say which of the three is actually responsible.

Both facts are true right now, independent of any decision made here. The invisible-off-switch D-8 warns about isn't a thing the stage-2 flip would introduce — it is already built, already shipped, and already silent. What stage 2 changes is not whether it exists, but whether anyone is exposed by it: while the default is `false`, an unannounced "off" changes nothing an operator would have noticed anyway; once the default flips to `true`, that same unannounced "off" silently reverts a production box to plaintext. So the question in front of you is not "should we allow an invisible off switch" — it is already allowed, and always has been since `e2ee` joined the registry. The question is which of three ways to live with a thing that is already here, before the default flip makes it consequential.

This paragraph is context, not an argument for any option below — it doesn't change what each option costs, only when the cost starts to bite.

## What's true on `origin/main` right now, verified

- `e2ee` registry entry: `default: false`, `env: "THREADBASE_FEATURE_E2EE"` (`src/feature-flags.ts:94-101`).
- Precedence, highest first: `override → env → cli → yaml → default` (`src/feature-flags.ts:279-282`, code at `:301-306`). Nothing is special-cased for `e2ee` — it goes through the same five rungs as every other flag.
- R1 (`--no-e2ee`) lands on the **cli** rung, as sugar for `--feature e2ee=false` (`cli/no-e2ee.ts`). It does not add an env var or a `server.yaml` key of its own — D-8's "serve flag only" rule holds *for R1*.
- The precedence itself is pinned by a real test: `__tests__/e2ee-no-e2ee-flag.test.ts:96`, `"does NOT beat the environment variable, which is the documented precedence"` — asserts `THREADBASE_FEATURE_E2EE=1` beats `--no-e2ee`, i.e. env wins. Its comment states plainly: *"R2 escalates the collision to the user; R1 must not pre-empt it by carving a special case."* That comment is now stale the moment you decide — see per-option notes below for whether the assertion itself also moves.

## The three options (from `dilemmas.md` D-8, lines 169–189)

### Option 1 — Exempt `e2ee` from the env rung

Give `e2ee` a resolver path that skips the `env` lookup entirely, so only `override → cli → yaml → default` apply to it.

**Keeps:** D-8's rule intact and enforced in code, not just in prose — no environment variable can silently hold encryption off.

**Costs:**
- Breaks the *documented stage-1 enable path*: `misc.routes.ts:216-218` currently tells an operator to set `THREADBASE_FEATURE_E2EE=1` to turn E2EE on for a supervised instance whose argv is fixed (launchd/systemd/Task Scheduler can't pass `--feature`). Exempting `e2ee` from the env rung removes that path for *enabling* it too, not just disabling — unless the resolver is changed to treat the env var asymmetrically (honour it to turn E2EE on, ignore it to turn it off), which is a special case inside a special case and a real complexity cost.
- Breaks the flag registry's uniformity guarantee: every other flag in `FEATURE_FLAGS` gets identical treatment from `resolveFeatureFlags()` (`src/feature-flags.ts:279-306`), and the whole point of that resolver (per its own doc comment) is that a caller never has to ask "does this one work differently?" `e2ee` would become the one exception, forever, and every future reader of `feature-flags.ts` has to learn it.
- `docs/guides/feature-flags.md` and the `Feature flags` section of `tb-streamer/CLAUDE.md` (which currently documents `THREADBASE_FEATURE_<ID>` as the uniform, highest-precedence override for *every* flag) would both need a carve-out.

**What it changes in code and tests:**
- `src/feature-flags.ts`: `resolveFeatureFlags()`'s rung list becomes conditional on `def.id`, or `e2ee` gets pulled out of the generic loop into its own resolution branch.
- `__tests__/e2ee-no-e2ee-flag.test.ts:96` — the assertion **flips**: `THREADBASE_FEATURE_E2EE=1` would no longer beat `--no-e2ee` (or would stop mattering at all, depending on whether env is dropped entirely or only for disabling). This is the "test changes as part of the implementation, deliberately" the task brief flags — under this option the change is a real behavior flip, not a comment update.
- A new test proving the stage-1 enable path still works some other way (or an explicit decision that supervised instances lose the ability to opt in to E2EE without an argv change, which contradicts the flag's own doc comment).

**What a stage-1 operator relying on `THREADBASE_FEATURE_E2EE=1` experiences:** their launchd plist, systemd unit, or Task Scheduler action stops working the moment this ships — the variable they set to turn E2EE on for a supervised instance whose argv is fixed is now inert. They get no error; `e2ee` just silently reads as `false` again unless they also happen to hold a `--feature`/`server.yaml` path open. They would need a different way to enable it on a fixed-argv box — an editable `server.yaml` line if `yaml` is left in the rung order, or an argv change to the service definition itself (exactly the "visible, auditable change" D-8 asks for on the *disable* side, now also required on the *enable* side).

### Option 2 — Accept the variable, drop D-8's no-env-var rule as unenforceable

Formally concede: `THREADBASE_FEATURE_E2EE` is a real, persistent, invisible off switch once stage 2 ships, exactly as D-8 warned, and the registry's uniformity is worth more than closing that one hole.

**Keeps:** The registry stays uniform, zero special cases, zero new code. `docs/guides/feature-flags.md` needs no exception written into it.

**Costs:** Gives up the actual guarantee D-8 exists to provide — "encryption cannot be turned off invisibly and persistently" stops being true the day stage 2 ships. An operator (or a copy-pasted launchd plist, or a stale CI env block) with `THREADBASE_FEATURE_E2EE=0` set keeps every future boot in plaintext with **no warning of any kind today** (see the `src/server.ts:2404` guard above — it fires only on `source === "cli"`), because option 2 makes no code change to that guard either.

**What it changes in code and tests:** Nothing, as stated. This can genuinely be a **documentation-only** change: `dilemmas.md` D-8 gets a resolution note recording that the rule is dropped and why, and `design.md` §6.4/§6.5 get a line acknowledging the env var is a real, standing off switch once the default flips. `__tests__/e2ee-no-e2ee-flag.test.ts:96` stays exactly as written — it already asserts the behavior this option accepts. Its stale "R2 escalates..." comment should still be updated to say the collision was resolved by accepting the status quo, but that's prose, not an assertion change.

**What a stage-1 operator relying on `THREADBASE_FEATURE_E2EE=1` experiences:** nothing changes for them. This is the only option that touches no code path they use — the variable keeps working exactly as documented today, both to enable and, later, to disable.

### Option 3 — Keep both; fire the boot warning on any flag-off source, name the source in `/api/info`

Don't remove the env var and don't pretend the risk isn't there — make every source that turns `e2ee` off announce itself, the same way `--no-e2ee` already does. `--no-e2ee` becomes explicitly just sugar for `--feature e2ee=false` (it already **is** this today per `cli/no-e2ee.ts`'s own doc comment — this option doesn't need to build that part, it's shipped).

**This is the reviewer's recommendation on file** — `tracks/REVIEW-2026-08-29-mega-brain.md:173` (finding N1): *"at stage 2 treat flag-off from any source exactly like `--no-e2ee` (boot warning naming the pinned-device count, `e2ee.disabled` at warn, `/api/info` `reason` naming the source: env / `--feature` / `server.yaml` / `--no-e2ee`); the friction D-8 wanted comes from the warning and the 426s, not from hiding the switch."* Recorded here as a data point from the reviewer, not as this document's recommendation.

**Keeps:** The uniform registry (no exemption), and D-8's actual goal — nobody can be running plaintext-in-production without the boot log and every `/api/info` response saying so and naming why.

**Costs:** Doesn't remove the *possibility* of the persistent off switch, only makes it loud. An operator who never looks at boot logs or `/api/info` — or scripts around them — is still silently downgraded in the sense that matters to them, just not in the sense the code can detect. Also: at stage 2 with the default **on**, most deployments run e2ee on and say nothing; the moment an operator's env/yaml/default configuration disables it, this option means every single boot logs a warning forever until they remove the override — that's the intended friction, but it's a permanent log line, not a one-time nudge.

**What it changes in code and tests:**
- `src/server.ts:2404` — `warnIfE2eeDisabledOnTheCommandLine()`'s guard (`this.featureFlagSources.e2ee !== "cli"`) broadens to fire for any source that represents an explicit override away from the registry default at stage 2 — i.e. `cli`, `env`, and `yaml` (probably not `default`, since off-by-default was never a surprise before stage 2; needs an explicit ruling once chosen). The method likely gets renamed off "OnTheCommandLine" and its `reason: "cli"` log field becomes the real source.
- `src/api/routes/misc.routes.ts:205-211` — `disabledReason()` currently special-cases only `"cli"`; it grows branches for `"env"` and `"yaml"` so `/api/info` names the actual rung, not a generic three-way list.
- `__tests__/e2ee-no-e2ee-flag.test.ts` — new test cases: the boot warning firing for an env-sourced disablement and a yaml-sourced disablement, and `/api/info` reason text differing per source. The existing `:96` **precedence assertion stays true and unchanged** — env still beats cli, that part of D-8 vs §6.5 was never in question — only its comment describing the collision as unresolved becomes stale and should be corrected to record the decision. (This is the "comment changes, behavior doesn't" case referenced above, as distinct from option 1's real flip.)
- No change to `cli/no-e2ee.ts` — it is already exactly the "sugar for `--feature e2ee=false`" shape this option assumes.

## What deferring past stage 2 means

If the stage-2 default flip (R3) merges before this collision is decided, the code stays exactly as it is today: `THREADBASE_FEATURE_E2EE=0` silently and permanently reverts a box to plaintext, and neither the boot log nor `/api/info` says so — the existing guard at `src/server.ts:2404` only speaks for the `cli` rung. That is precisely the failure mode D-8 was written to forbid, now live in production rather than theoretical. Deferring doesn't freeze the risk in place; it activates it, because the risk was already conditioned on the default being `true`.

## Decision record

*(To be filled in once the user has chosen. Record verbatim enough that a later session can tell what was picked and what was merely considered.)*

- **Chosen option:**
- **In the user's own words:**
- **Date:**
- **If code is needed, PR #:**

## Next steps

1. Owner confirms **G-1** has landed.
2. This document is presented to the user, unedited from the options above.
3. User decides. Decision recorded here verbatim.
4. If the decision needs code (options 1 or 3), implement under the usual verification bar (real objects, positive/negative control, mutation per safeguard) on its own branch, in the streamer PR slot, after checking the slot is free.
5. If the decision is option 2, the change may be documentation only — `dilemmas.md` D-8 and `design.md` §6.4/§6.5 updated to record the resolution, no PR required unless the user wants the record committed as one.
