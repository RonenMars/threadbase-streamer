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

**What a stage-1 operator relying on `THREADBASE_FEATURE_E2EE=1` experiences:** the variable keeps working exactly as it does today for enabling. The only new experience is on the disabling side, and only once stage 2 makes the default `true`: an operator who sets `THREADBASE_FEATURE_E2EE=0` (or has it inherited from a copied plist) now gets a boot warning and a named `/api/info` reason every single time the process starts, where before there was silence. Someone deliberately running plaintext sees more noise, not less capability.

## What deferring costs — once past stage 2, and again past stage 3

Deferring this decision is not free and not flat; the cost step-changes at each stage boundary, stated here as fact, not as a case for deciding sooner.

**Past stage 2** (the default flip, R3): the code is unchanged from today — `THREADBASE_FEATURE_E2EE=0` still silently and permanently reverts a box to plaintext, and neither the boot log nor `/api/info` says so (`src/server.ts:2404` only speaks for the `cli` rung). Before stage 2 this costs nothing, because "off" was already the default and nobody is running a box that expects encryption. After stage 2, it costs exactly what D-8 was written to prevent: a production box silently downgraded, indistinguishable from a healthy encrypted one to anyone who isn't reading source. This is the point in the doc's framing section above — deferring past stage 2 doesn't create the invisible switch, it exposes the one that was already there.

**Past stage 3** (`e2ee.required: true`, out of scope for any diff in this program per the task brief, but relevant to the cost curve): at that point a plaintext-reverted device isn't merely unprotected, it's the exact downgrade the whole staged rollout in `design.md` §7 exists to make impossible — a pinned device is defined as one that should never speak plaintext again, and an invisible env-var revert at the server means it does anyway, without either side's pinning logic ever being consulted. The cost of an undecided D-8 collision at stage 3 is categorically worse than at stage 2: at stage 2 the exposure is "this box now runs plaintext when it shouldn't"; at stage 3 it is "this box is telling every device the downgrade-prevention guarantee holds while quietly not providing it." The curve is not linear — it is flat while the default is off, steps up hard at stage 2, and steps up again at stage 3.

## Decision record

- **Chosen option:** A combination not among the three drafted above — **option 2 plus a new option 4** — reached by the user and the owner brainstorming after reading this escalation.
- **In the user's own words:** "hand-off to proceed with 2+4"
- **Date:** 2026-09-04

**How option 4 was reached.** The brainstorm turned on a fact from the mobile client, re-verified against `origin/main` in `tb-mobile` before being recorded here: both channels decide sealed-vs-plaintext from client-held state only, never from what the server currently claims.
- `services/authed-fetch.ts:177` — `if (isPinned(target)) return sealedFetch(...)`, else `plaintextFetch(...)`.
- `services/ws-client.ts:190` — `const pinned = this.encryption.requireEncryption === true && !!this.encryption.serverPublicKey`.
- `isPinned` (`authed-fetch.ts:181-183`) — `requireEncryption === true && !!serverPublicKey && !!id`.
- The only call site anywhere in the app that sets `requireEncryption` to `false` is a deliberate user tap: `components/servers/ServerEncryptionSection.tsx:49`, inside a destructive-styled confirm alert (`stores/servers.ts:345` is the only setter, `stores/servers.ts:292` only ever sets it `true`).

Consequence: a server that disables E2EE via `THREADBASE_FEATURE_E2EE=0` (or any other source) does **not** silently downgrade its already-pinned devices — `authedFetch` and `WsClient` keep refusing plaintext to any device the app still considers pinned, so the app breaks loudly, on every request, rather than quietly accepting cleartext. The residual harms are narrower than D-8 assumed: (a) **first-contact pairing** — a *new* device pairing against a server that has (re)gone plaintext gets no protection to lose, because it was never pinned; (b) **operator self-deception** — an operator who believes the box is encrypting production traffic and isn't. Both are real, but neither is the "previously-protected device silently downgraded" scenario D-8 was written to prevent — that scenario requires the client to trust server-side state over its own pin, and it doesn't.

So D-8's rule is a **mechanism** rule ("no env var may hold encryption off") guarding against a **harm** ("a pinned device is silently downgraded") that the mechanism, as built, largely cannot cause. That reframing is why the user picked a combination outside the three drafted options rather than one of them as-is.

**Option 2 — the disposition (documentation only).** D-8's "no env var may hold encryption off" rule is **retired as unenforceable, not patched**. `dilemmas.md` D-8 gets a resolution note recording this reasoning (including the client-pin evidence above) so a later reader sees the rule was retired on evidence, not abandoned. `design.md` §6.4/§6.5 get a line acknowledging the env var is a real, standing off switch once the default flips. **No resolver change** — `src/feature-flags.ts` is not touched; every flag keeps resolving through the same five rungs (`override → env → cli → yaml → default`). Registry uniformity is the entire point of taking option 2 as the base.

**Option 4 — the replacement rule (code).** Source-agnostic and consequence-based: a boot that serves plaintext announces itself, naming the pinned-device count and the deciding source. This is option 3 from the original three, generalized past "any source" to *all four non-default rungs*, with the design question below settling exactly when it fires:
- `src/server.ts:2405-2406` (`warnIfE2eeDisabledOnTheCommandLine`) — the guard broadens off `this.featureFlagSources.e2ee !== "cli"`; the method is renamed off "OnTheCommandLine" since it is no longer CLI-specific; its `reason` log field carries the real source instead of the literal `"cli"`.
- `src/api/routes/misc.routes.ts:202-213` (`disabledReason`) — grows branches so `/api/info` names the actual rung (`env` / `cli` / `yaml`) instead of collapsing `env`/`yaml`/`default` into one generic line.
- The pinned-device count machinery already exists at `server.ts:2417-2421` (`repo.list().filter((d) => d.e2ee && d.revokedAt == null).length`) and is reused as-is, not rebuilt — the method's own comment already says it is called after `devicesRepo` opens "since the count is the point."

**Why option 5 (a boot refusal gated on the pinned count) was dropped, and why that's cheap under 2+4.** Option 5 would have made the pinned count **load-bearing** — a value the boot decision depends on, not just reports. `server.ts:2417-2421`'s own comment carries the `#744` caveat: a pairing whose `msg2` was lost leaves a row that is pinned but has never connected, so the count "counts intent to encrypt, not devices in anyone's hand." Under option 5, a ghost row from a lost `msg2` could have locked an operator out of disabling encryption for a device that was never actually in anyone's hand. Under 2+4 the count stays **advisory** — it enriches a warning a human reads, never gates a boot decision — which is the regime `#744`'s caveat was already written for. That's a large part of why this combination is cheap: it needs no `#744` fix as a prerequisite.

**Explicitly not in scope:** no refusal to honour a config-sourced disable, no argv-level requirement for disabling, no boot refusal of any kind. No scaffolding or TODOs for option 5 are to be left in the diff.

- **If code is needed, PR #:** *(filled in once opened — see Process below)*

## The trigger design question (settled by the implementing session)

Today the warning fires whenever the `cli` rung disabled `e2ee` — **including at zero pinned devices**, where its own text says "no paired device requires it." A strictly consequence-gated trigger (only warn when the pinned count is `> 0`) would **remove** a warning that fires today for a `cli`-sourced, zero-device disable, which is a regression in visibility even though it reads as more faithful to option 4's "consequence-based" framing.

**Chosen: keep warning whenever `e2ee` is off from any explicit non-default source (`override`, `env`, `cli`, `yaml`), regardless of the pinned count; let the count enrich the text and severity, never gate whether the warning fires.** Never remove a warning that exists today.

Reasoning: the zero-count case is exactly the boot the reviewer's original recommendation (`tracks/REVIEW-2026-08-29-mega-brain.md:173`, N1) was about — the friction D-8 wants "comes from the warning and the 426s, not from hiding the switch," and a freshly-disabled box with zero pinned devices today is precisely the boot where an operator most needs to see "you just turned this off" *before* any device gets pinned against it, i.e. before the count-gated version would ever speak. Gating on count would make the warning a lagging indicator (fires only after someone has already paired against plaintext) instead of a leading one (fires the moment the box boots plaintext, so pairing against it happens knowingly). That is a strictly worse trade for a mechanism this cheap to run on every boot. `default` stays exempt — off-by-default was never a surprise before stage 2, and warning on every default boot today (with `e2ee`'s registry default still `false`) would be pure noise with no decision behind it to announce.

## Next steps

1. Owner confirms **G-1** has landed.
2. This document is presented to the user, unedited from the options above.
3. User decides. Decision recorded here verbatim.
4. If the decision needs code (options 1 or 3), implement under the usual verification bar (real objects, positive/negative control, mutation per safeguard) on its own branch, in the streamer PR slot, after checking the slot is free.
5. If the decision is option 2, the change may be documentation only — `dilemmas.md` D-8 and `design.md` §6.4/§6.5 updated to record the resolution, no PR required unless the user wants the record committed as one.
