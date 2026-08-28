# Group A — Evidence Protocol (DRAFT, awaiting approval)

Governs both probers. Source rules: workspace `CLAUDE.md` §5–6; `codex-results.md` "D. Gate 0", "Discoveries that stop a phase", "Methodology Review". This protocol adds nothing to those rules; it only makes them mechanical.

## 1. Version matrix (recorded 2026-08-27, this machine)

| Provider | Installed | Prior evidence | Consequence |
|---|---|---|---|
| Claude Code | **2.1.247** (`/opt/homebrew/bin/claude --version`) | streamer fixtures claim 2.1.214; research captures 2.1.239 / 2.1.241 | Drift is finding **C0** on the Claude scorecard. All Claude probes are first captures for this version. |
| Codex | **0.150.1** (`/opt/homebrew/bin/codex --version`) | captures for 0.149.0 (`~/dev/ai-tools/docs/ai-questions-planning-and-research/2-researchers-feature-research-record.md`) | Version changed ⇒ the six "already proven" 0.149.0 facts are **recertified** as rows X0.1–X0.6, not assumed. Prober states this explicitly. |

A prober that finds a different binary on `PATH` than the one above stops and reports before probing.

## 2. Evidence unit

One directory per probe: `evidence/<provider>/P<nn>-<slug>/` containing:

| File | Content |
|---|---|
| `META.json` | `{binary, binary_sha256, version, flags, env (redacted), config_dir (the redirected home, §8), config files + sha256, cwd, session_or_rollout_id, transcript_path, pids: {provider, control_client[, terminal]}, started_at, ended_at, time_spent, attempts}` — a probe without every field is not evidence. |
| `frames.jsonl` | Every control/app-server frame in both directions, verbatim, prefixed `{"t": <ms>, "dir": "in"|"out", ...}`. Redacted per §5. |
| `effect.txt` | The external observable checked (file sha/content, transcript tail, `ps` line, prompt settlement), captured **before and after**. |
| `controls.md` | Which controls from §3 ran, their raw result, and the one that would have flipped the row. |
| `harness.*` | The disposable script(s) used, exactly as run. |
| `terminal.log` (P09/X01 only) | `script(1)` capture of the real terminal. |

No production source, no repo commit, no `node_modules` install into either repo for these harnesses. Harness runtime: node from nvm on `PATH` (`export PATH="$HOME/.local/bin:$PATH"`); binaries by absolute path.

## 3. Controls (required per probe; row is UNPROVEN without them)

| Control | Meaning | Applies to |
|---|---|---|
| **PC** positive | harness observes a known-true fact through the same mechanism (e.g. sentinel written by hand appears in the transcript tail read by the harness) | every probe |
| **NC** negative / counterfactual | the opposite input produces the opposite effect (deny ⇒ file absent; wrong id ⇒ refusal; unknown kind ⇒ zero bytes written) | every causal claim |
| **EE** external effect | the file / transcript / process / prompt settlement, never only a 200 or RPC ack | every row |
| **MUT** mutated safeguard | invert the assertion once and show the harness fails **for the intended reason** (log the failing output) | every row marked pass |
| **ID** identity | exact UUID / rollout id / path compared before and after; `ls` of the sessions dir before and after to prove no second file | identity, continuity, writer probes |

Specific controls the doc names, mapped to probes: allow+deny effects (C02, X0.1); known-good + deliberately unsupported dialog kind (C03, X05); before/after transcript sentinel (C01, C09, X01); answer-before-expiry vs actual expiry (C04); second writer same identity + wrong identity (X07, C07); terminal usability after refused attachment (C09, X01); mutated assertion (all).

## 4. Tags (exactly one per row)

- **PROVEN BY LIVE CAPTURE** — `frames.jsonl` + `effect.txt` + PC + NC/MUT all present for the installed version.
- **DOCUMENTED-TYPED** — only types/docs/`--help` say so; never counts as runtime evidence and never supports a pass.
- **INFERRED** — deduced from an adjacent capture. Orchestrator bounces any INFERRED row where a capture was possible.
- **UNPROVEN** — not captured, or controls incomplete.

Row verdicts: `pass` / `fail` / `unknown`. `pass` requires PROVEN BY LIVE CAPTURE. "Mostly works" is `unknown`.

## 5. Redaction

Before any file is preserved: replace values of `*_KEY`, `*_TOKEN`, `Authorization`, `cookie`, OAuth blobs, and anything matching `sk-[A-Za-z0-9_-]{8,}` with `<REDACTED:sha256[:8]>`; strip `~/.claude/.credentials.json`, `~/.codex/auth.json` contents from any env dump. Prompt/answer **content** may appear in `frames.jsonl` (it is the object under test) but must never appear in any streamer or harness log line — a prober that sees it there fires stop-work trigger T4.

Auth in scratch homes: copy `~/.claude/.credentials.json` / `~/.codex/auth.json` into the redirected home at probe start; record the **destination path only** in `META.json` (never contents); delete every copy at track end (`find evidence/<provider> -name '.credentials.json' -o -name 'auth.json' | xargs rm`, logged in the final report).

## 6. Stop-work triggers (prober writes `STOP-<Tn>.md` and reports immediately)

T1–T6 and T8 **halt the track**. T7 and T9 (owner's decision): report immediately, then **continue every row that does not depend on the missing/hidden capability** and mark dependent rows `unknown / blocked-by-T7|T9`; the finding is itself the gate's deliverable. Never enable a hidden flag to keep going.

| # | Trigger |
|---|---|
| T1 | session identity forks (second transcript/rollout for one session) |
| T2 | two writers land on one transcript |
| T3 | terminal-origin history not preserved after attach/detach |
| T4 | prompt or answer content in logs / unrelated clients |
| T5 | unknown actionable request cannot fail closed (bytes written, or auto-answered) |
| T6 | pending prompt cannot be reconciled after reconnect |
| T7 | the capability needed (Codex `requestUserInput`) is hidden/default-off/absent in the installed version |
| T8 | no recovery path for an active structured session after streamer (control-client) failure |
| T9 | an undocumented provider capability flag is encountered |

## 7. Scorecard row shape (`evidence/<provider>/SCORECARD.md`)

`| id | probe | verdict | tag | evidence dir | PC | NC/MUT | flipping control | time_spent | notes/gaps |`

**Time-box:** at most 3 harness attempts or ~45 min per row; then record `unknown` with the reason, move on, report the row.

## 8. Isolation

Each prober reads only `evidence/<own provider>/`. Sessions for probes run in fresh scratch cwds under the prober's evidence dir (`P<nn>/cwd/`), never in `tb-streamer`/`tb-mobile`.

**Redirected homes — never pollute the real stores** (the user's streamer scans `~/.claude/projects` and `~/.codex/sessions`): every probe runs with `CLAUDE_CONFIG_DIR=<probe dir>/claude-home` / `CODEX_HOME=<probe dir>/codex-home`. The first positive control of C01 / X0.1 verifies the installed version honours the variable (session file lands under the redirected home, real dir listing unchanged). If not honoured: say so, and fall back to a dedicated `TB-PROBE-<date>` subfolder/prefix under the real dir, listed in `META.json.config_dir`. C09/X01 terminal-origin rows use the same redirected homes; the binary is still the real object.

Real-store facts (2026-08-28): `~/.claude` → symlink `~/dotfiles/ai-tools/claude` (so `~/.claude/projects` physically lives there); `~/.codex/sessions` is a real dir. Probers record `readlink -f` of both real stores in `META.json.real_store` and assert the redirected home is not beneath either; the before/after listing for the ID control is taken on the physical path.

Pre-existing artefacts in the real Claude store — **not this run's evidence, leave untouched** (22 Aug research):
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-ask-5XOFDj`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-carousel-g2Vznz`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-digit-CSkOC7`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-fetchgate-T4YlQE`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-gate-JgDiap`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-gate-Jx5vuk`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-gate-qOIF3L`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-gate-vTkGVV`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-highlight-SGlSdk`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-multi-pej4rd`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-multidigit-Joa1D4`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-refusal-J0yqq6`
  - `-private-var-folders-9r-c18379-13-q6tl6x-k9bhyqh0000gn-T-tbprobe-typesth-fOn0ba`

The C01 (and X0.1) "no new file in the real store" ID control diffs against a listing captured at probe start (`ls -la` saved as `store-before.txt`), never against an empty expectation.

