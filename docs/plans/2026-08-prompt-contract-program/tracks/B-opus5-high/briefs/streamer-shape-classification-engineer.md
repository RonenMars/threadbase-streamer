# Brief — `streamer-shape-classification-engineer`

Repo: `tb-streamer`. Issue: **#721 (P1)** — "screen→contract mapper publishes a multi-select form as a single-select prompt, defeating fail-closed answers". Nothing else.

**Cite from `origin/main` only, never a checkout** (`c=origin/main; /opt/homebrew/bin/git show "${c}:<path>"`). Base is `4be88979` (v1.70.2, contains #720's fix). All lines below are from there.

## 1. Where it starts — my read, which you verify or correct

`src/services/questions/detectQuestionFromScreen.ts:130` returns
`questions: [{ question, header: "", multiSelect: false, options }]`
— one question, `multiSelect` **hardcoded false**. `ptyPromptAdapter.ts:47` then maps `inputMode: question.multiSelect ? "multi" : "single"`, so the contract's `single` is not a misjudgement by the mapper; it is the only thing the scraper can express. The option-row regex (`:30`, `:97`) trims and takes the label as written, which is how `[ ]` glyphs reach the payload as literal text, and `PERMISSION_LABEL_RE` (`:38`, `:98`) only rejects permission gates.

So there are three separable defects and the plan must say which it is fixing:
- the scraper cannot **represent** multi-question or multi-select at all;
- it cannot **detect** that it is looking at one;
- labels carry presentation glyphs.

## 2. The requirement — ruled, do not re-derive

- A multi-select / multi-question / free-text form is published with the correct `inputMode` and question count, **or**, when the scraper cannot determine the shape, is published as unanswerable — an `answerRequirement` other than single-select, or a shape the answer route refuses with `unsupported_prompt_shape` — so that **zero bytes** are written.
- **Never guess `single`.** Guessing is the defect; an honest "I cannot classify this" is the fix. If your rule cannot tell a genuine single-select menu from an unrecognised form, it must fail towards unanswerable, not towards answerable.
- Option labels never contain checkbox or cursor glyphs.
- The existing single-select permission gate still maps and answers exactly as before — that is the positive control and it is load-bearing, because a classifier that refuses everything would satisfy every other requirement here.

## 3. Reproduce first, classify second — the owner's explicit sequencing

**Before proposing any classification rule, reproduce row 7 on the real detector path** and show me what the scraper actually returns for that screen: the question count, `multiSelect`, and the option labels byte for byte. Two reasons this order is mandatory rather than tidy: your rule has to key on something actually present in the capture, and the last agent on this repo found that the previously-agreed requirement was vacuous only because it ran the real path first.

Evidence is at `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/C-opus5-medium/evidence/721-row7/`. The four `B-row7-screen-7*.json` files are the captured screens and are your fixture source.

**SECRETS — a hard constraint.** `streamer-170.log`, `B-row7-tap.jsonl` and `B-row7b-tap.jsonl` in that directory **contain the `tb_` pairing key** (the taps log it in argv — see #723). I checked; the four screen JSONs do not. Never copy those three files, or anything derived from them, into the repo. Any fixture you do bring in: grep it for `tb_` yourself before staging rather than trusting my check, and say in your report that you did.

## 4. Plan deliverable — then stop

1. What the real detector path returns for the row 7 screen, from an actual run.
2. Which of §1's three defects you fix and which you leave, with a reason. Fixing "cannot represent" without "cannot detect" produces nothing; fixing detection without representation can only produce the unanswerable path. Say which combination you are shipping.
3. The classification rule, stated so it can be argued: exactly what evidence on screen distinguishes an unanswerable form from a single-select menu, and what it does when that evidence is absent or partial. Name the false-positive direction it can fail in and why that direction is the safe one.
4. Where the unanswerable shape surfaces — a different `answerRequirement`, a refused answer at the route, or both — and what a released client (mobile `40ac02ac`) does with it. It fails closed on multi-question, multi-select and free-text today; your shape must land in a bucket it already refuses, not a new one it will render as tappable.
5. Tests: the fixture-driven test on the real detector path proving no `inputMode: "single"` for this form and that the route refuses an answer with **zero bytes**; the positive control that the existing single-select gate still maps and answers; the mutation that forces the old classification and goes red. Name each and say what fails today.

## 5. Out of scope

`performAnswer` and #720's settlement logic (shipped in v1.70.2 — do not touch it), `/queue`, `/plan-response`, status models, the mobile client, and #724's transient mint. List findings; do not fix them.

## 6. Mechanics

- Worktree `tb-streamer/.worktrees/fix/<slug>` off `origin/main` (`4be88979`); `node_modules` symlink; Node from `.nvmrc`.
- `npx biome check <explicit files>` and `npx tsc --noEmit` separately; `tsconfig.json:21` excludes `__tests__`, so tsc does not type-check your tests.
- `npm test` is ~11-14 min: run it in the background and **wait on it inside your turn**, do not go idle with it pending.

## 7. Protocol

Plan first, then stop. I review, the program owner approves, then you implement. Then full suite + tsc + biome + build green, staged diff, `--stat`, exact commit message, and every mutation's failing test name with verbatim assertion — then stop again. No commit, push, PR or merge without my relayed approval. Conventional title, no AI attribution, PR prose one sentence per line, never push to `main`.
