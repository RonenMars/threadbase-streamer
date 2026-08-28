# Brief — `mobile-card-identity-engineer`

Repo: `tb-mobile` (`RonenMars/threadbase-mobile`). Issue: **#871** — "key permission-card dedupe on gateId when the streamer sends one". Nothing else.

## 1. Verified state, re-confirmed on `origin/main@3b2cca63` (2026-08-28)

The issue cites `main@fcd1ba72`. **Corrected 2026-08-28**: the numbers below are read from `origin/main@3b2cca63` itself — the working checkout is on `fix/rtl-directional-layout`, which predates #872, and the first issue of this brief cited it by mistake. `hooks/useActiveQuestion.ts` is **355** lines there, and **five** `useActiveQuestion*.test.tsx` files exist (`useActiveQuestion.prompt.test.tsx` is the fifth, added by #872).

- `gateKey(msg)` **:41–44**, its comment :37–40.
- The suppression rule and its documented ceiling **:86–102**, the `ponytail:` line at **:101–102**; `dismissedKey` itself **:103**.
- The sentence this change makes **false**: **:152** — "…and it depends on no field an older streamer might not send." The "do not simplify this to permissionContentKey" paragraph is **:154–160** and stays true; it needs re-scoping to the fallback, not deletion.
- Permission branch **:252–255**; `gateId` already reaches it (`types/api.ts:334`, `utils/mapPermissionToBlock.ts:9–16`) and is used for the answer payload only.
- `markPending` **:165–170**, `expireIfStale` **:182–187**, `resetAndUnsuppress` **:208–211**, `applyPrompt` **:220–228**, the legacy-frame drop **:245**, `clear()` **:262–265**.

## 2. The change

`gateKey` returns `msg.gateId` when the frame carries one, and the current content-derived string otherwise. Signature, call site and every consumer stay as they are. That is the whole change; anything larger is out of scope.

Two things are load-bearing and must survive:

- **The old-streamer path is a control, not a leftover.** The long comment at :154–160 ("Do not simplify this to permissionContentKey, or to anything else derived from a field the old wire format does not carry") explains why the fallback exists. After your change that comment must still be *true* — it now describes the fallback rather than the whole key. Update its wording only as far as accuracy requires, and prove in a test that the no-`gateId` frame produces a **byte-identical** key to today's.
- **Mixed keys must not collide.** Once the key can be either a UUID-ish server id or a content string, `dismissedKey` compares across both. A gate answered while the streamer sends `gateId`, followed by a frame with none (or the reverse — a reconnect to an older server), must not accidentally match. Say in your plan what makes a collision impossible, or make it impossible.

Contract-path cards (`source: 'prompt'`, keyed on `promptId` since #872) are untouched — verify that the prompt-frame branch does not route through `gateKey` at all, and state the file/line that proves it.

## 3. Out of scope

The composer refusal message (#870 — being implemented right now by Group D on `fix/ghost-send-refusal-message`; do not touch `LiveConversationView`, `TerminalView` or the locale files), the answer payload, `mapPermissionToBlock`'s shape, the ghost TTL, status models, any cleanup you notice. List findings at the end of your report; do not fix them.

## 4. Tests — real hook, controls, one mutation

`__tests__/unit/hooks/useActiveQuestion*.test.tsx` are the home (five files exist; `useActiveQuestion.phase.test.tsx` is the closest fit). Drive the real reducer through `onMessage`/`markPending`, not a reimplementation.

1. **Positive**: gate with `gateId: "g1"` → `markPending` → an *identical-content* gate arrives with `gateId: "g2"` → a fresh card appears. This is the bug; it must fail before the change.
2. **Negative control**: same `gateId: "g1"` repainted with a moved cursor after the answer → still suppressed, no card. This proves the new key did not simply disable suppression.
3. **Old-streamer control**: frames with **no** `gateId` → behaviour identical to today, and the computed key byte-identical to the current content string (assert the value, not just the behaviour).
4. **Mixed-source**: an answered `gateId` frame followed by a no-`gateId` frame of the same content (and the reverse) behaves sanely per whatever you argued in §2.
5. **Untouched**: an existing `source: 'prompt'` test still passes unchanged — cite it.
6. **Falsifiability mutation**: revert `gateKey` to the content-only key, run the suite, report **the failing test name and its assertion text**, then restore.

## 5. Mechanics

- **Cite from `origin/main` only, never a checkout.** Both working checkouts sit on stale branches; read files with `c=origin/main; /opt/homebrew/bin/git show "${c}:<path>"`. Every line number in this brief was verified that way, and any you re-derive must be too.
- Worktree **outside** the repo, sibling only: `/opt/homebrew/bin/git worktree add ../tb-mobile-worktrees/<slug> -b fix/<slug> origin/main`. Never nested — a nested worktree makes jest report phantom failures from a stale branch (tb-mobile `CLAUDE.md`:41–53).
- Its own `npm ci` (~3 min, no symlink). If `node_modules/.bin` comes out empty or `jest-cli` half-extracted: `rm -rf node_modules && npm ci`. **Never `npm rebuild --bin-links`** — it re-corrupts `jest-cli`.
- `npm run test:ci` mutates the tree as a side effect (bumps `ios.buildNumber` in `app.json`, writes `__tests__/unit/scripts/.git-status-before.txt`). **Revert both before staging** or the bump gets committed.
- Confirm any suspicious failure serially: `npx jest --ci --runInBand --testPathPattern "<name>"`.
- Lint the staged files before commit: `npx eslint <files>` (zsh does not word-split `$FILES` — pipe through `xargs`). `i18next/no-literal-string` is an error-level rule.
- Full suite, lint and `tsc` green before the diff is presented.

## 6. Protocol

Plan first — the key rule, the collision argument, the comment rewrite, the test list — and **stop**. I review it, the program owner approves, then you implement. After implementation: suite + lint + typecheck green, tree clean of the `test:ci` side effects, then present `git diff --staged`, `--stat` and the exact commit message; stop again. No commit, push, PR or merge without my relayed approval.

Merge order, already ruled: open the PR and take it green, then **hold the merge until Group D's #870 is `MERGED`** (one PR at a time on tb-mobile), then rebase → CI → squash. Do not merge on your own; I do the merge after the program owner's yes.

Commit title: conventional, imperative, lowercase, no trailing period, e.g. `fix(prompts): key permission-card dedupe on gateId`. No AI attribution. PR prose one sentence per line. Never push to `main`.
