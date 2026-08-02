# Investigation prompt — session source, stop and overtake for Codex

**Date:** 2026-07-30
**Companion:** [session-source-visibility-and-control.md](./session-source-visibility-and-control.md) — the equivalent spec for `claude-code`, which this investigation must produce a counterpart to.

The prompt below is paste-ready. Everything above the `---` is context for whoever runs it.

---

## Paste this

```
Investigate session source detection, stop, and overtake for the codex-cli
provider in tb-streamer, and produce a spec mirroring
docs/plans/session-source-visibility-and-control.md (which covers claude-code).

Work in your own worktree, branched from the current integration branch:
  /opt/homebrew/bin/git worktree add -b docs/codex-source-visibility \
    ~/dev/ai-tools/tb-streamer-worktrees/docs-codex-source-visibility \
    integration/missing-prs-2026-07-23

## Method — this is the important part

The claude-code spec was produced empirically, and the method caught three of
its own wrong conclusions before they shipped. Use the same discipline:

1. MEASURE, don't infer. Run real Codex sessions from each host you can reach
   (terminal, VS Code extension, Codex Desktop, `codex exec`) and diff what
   they leave behind — rollout JSONL, argv, tty, process ancestry.
2. A corpus sample is a SNAPSHOT. The claude-code investigation concluded "the
   JSONL cannot distinguish these sources" from a grep taken ten minutes before
   the relevant session existed. Re-measure after starting each new session.
3. State what you could NOT test. Uncalibrated rules derived from docs alone
   must be labelled as such, not presented as findings.
4. Every claim goes in an Evidence section with the exact command that produced
   it, so the next person can re-run it rather than trust it.

## Already established — do not re-derive

Codex rollout headers are RICHER than Claude's. The first line of every
rollout is a `session_meta` record whose payload carries:

  id, session_id, cwd, timestamp, originator, source, thread_source,
  cli_version, model_provider, base_instructions

Observed distribution across 244 rollouts in ~/.codex/sessions (2026-07-30):

  152  originator=codex-tui                        source=cli
   62  originator=Codex Desktop                    source=vscode
   11  originator=codex_exec                       source=exec
    6  originator=codex_work_desktop               source=vscode
    5  originator=codex_vscode                     source=vscode
    3  originator=codex-chrome-extension-sidepanel source=vscode
    5  originator=codex-tui                        source={'subagent': ...}

Three consequences, all needing verification:

 A. `originator` looks like a first-class launch-host field — better than
    Claude's `entrypoint`, which needed process ancestry to separate terminal
    from everything else. Confirm whether ancestry is needed for Codex at all.
 B. `source` is NOT always a string. It can be a structured object, e.g.
    {'subagent': {'thread_spawn': {'parent_thread_id': ..., 'depth': 1,
    'agent_path': ..., 'agent_nickname': ...}}}. Any parser typing it as
    string will break. Establish the full shape.
 C. `source=vscode` spans FOUR different originators, so `source` alone is too
    coarse to identify the host. Decide which field the spec keys on.

## The gap that likely blocks everything

`looksLikeClaudeProcess` (src/process-discovery.ts:61) matches only:
  - an executable whose basename is `claude` / `claude.exe`, or
  - a JS runtime (node/bun/deno) running `claude-code/(cli|index).js`

Codex ships as a Rust binary named `codex` (/opt/homebrew/bin/codex on this
machine), so it matches NEITHER branch. Verify, but the expected finding is
that **no Codex process is ever discovered**, which means:
  - Codex sessions never appear in /api/sessions as `ownership: "external"`
  - `POST /api/sessions/:id/adopt` cannot reach them (handleAdopt calls
    discoverClaudeProcesses)
  - the entire stop/overtake surface is unreachable for Codex

If that holds, the spec's first phase is extending discovery, not filtering it.
Decide whether that means generalising `looksLikeClaudeProcess` into a
provider-aware matcher or adding a parallel `discoverCodexProcesses()`, and say
why. Note the existing `codexRoots` config and `resolveCodexExe()`
(src/platform.ts) as prior art for where Codex paths are already resolved.

## Questions the spec must answer

Detection
 1. Can `originator` alone classify the launch host, or is ancestry still
    needed? Test each host you can reach and record argv + tty + ancestry.
 2. Is `originator` stable within a rollout, or can it vary line to line the
    way Claude's `entrypoint` did? (One Claude transcript carried a stray
    `cli` inside an attachment payload — first-occurrence reads were correct,
    any-occurrence reads were not.)
 3. What is the full type of `source`? Enumerate every shape in the corpus.
 4. How do sub-agent threads (`thread_spawn`, `parent_thread_id`, `depth`)
    map to the streamer's existing agent-filtering concept
    (services/conversations/isAgentConversation.ts, THREADBASE_INCLUDE_AGENTS)?
    Should a Codex sub-agent thread be hidden the same way?
 5. Does `codex exec` (originator=codex_exec, source=exec) run headless the way
    the Claude desktop app does (--output-format stream-json, no TTY)? If so it
    inherits the same "cannot be attached to, must not be overtaken" conclusion
    — see §2.3 and §4.4 of the claude-code spec.

Remote / cloud
 6. Does Codex have an equivalent of Claude Code's Remote Control — a local
    process driven from a web or mobile client? Check Codex cloud/web, the
    Chrome extension sidepanel originator (which implies a browser surface),
    and any `codex` subcommand that registers a remotely-drivable session.
    If yes, it needs the same orthogonal `remoteControlled` treatment
    (§2.8/§9.2 of the claude-code spec), NOT a new source value.

Control
 7. Can a Codex process be stopped safely? CodexPtyRunner already documents
    that SIGINT produces a clean exitCode=0 (codex-pty-runner.ts:553). Confirm
    for an externally-started process, and decide SIGTERM vs SIGINT.
 8. Can a Codex session be overtaken? `codex resume <rollout-id>` is already
    implemented (codex-pty-runner.ts doStart). The blocker is identity: for a
    FRESH Codex session the streamer only learns the rollout id via
    watchForCodexRollout (server.ts:4711). For an EXTERNAL one, does argv carry
    a resumable id, or must it be bound by cwd + start-time correlation the way
    §2.5 of the claude-code spec does for the Claude desktop app?
 9. Do Codex's startup gates (directory trust, hooks review — see
    codex-pty-runner.ts CODEX_TRUST_GATE_REGEX / CODEX_HOOKS_GATE_REGEX)
    change what a respawn-after-kill looks like? An overtake that lands on a
    blocking gate is worse than one that does not.

## Traps

- `~/.codex/sessions` is date-partitioned (<root>/YYYY/MM/DD). Recurse.
- Claude's project dirs begin with `-` (`-Users-…`), which makes unguarded
  grep/head/basename fail — grep fails SILENTLY and looks like a clean
  no-match. Codex paths do not have this problem, but if you compare the two
  corpora, guard Claude paths with `./` or `--`. See §2.5 of the claude-code
  spec.
- Do not assume parity with Claude. The two providers differ in identity model
  (Codex assigns its own rollout id; Claude accepts --session-id), in process
  type (Rust binary vs node), and now apparently in metadata richness.

## Deliverable

docs/plans/codex-source-visibility-and-control.md, structured like its
claude-code counterpart: what already exists, detection rules with evidence,
the discovery gap and its fix, wire + persistence + filters, stop and overtake
policy per source, tb-mobile compatibility, risks, test plan with exact files,
PR checklist, and an Evidence section.

Where a conclusion mirrors the claude-code spec, cross-reference it rather than
restating it. Where it diverges, say so explicitly and give the measurement.

Do not implement anything. Analysis and spec only.
```

---

## Why this prompt is shaped the way it is

**It front-loads measured facts.** The `originator` distribution above took one command; handing it over means the investigation starts from a real baseline instead of spending its first hour rediscovering it — and, more importantly, means a wrong baseline can be challenged rather than silently assumed.

**It names the likely blocker up front.** If Codex processes are invisible to discovery, then filtering, stopping and overtaking are all downstream of a discovery fix, and an investigation that starts with "add a `?source=` filter" would build on nothing. Better to have that verified or refuted in the first ten minutes.

**It carries the method, not just the questions.** The claude-code spec's three self-corrections — the corpus snapshot, the silently-failing grep, the `remote-controlled`-as-a-source mistake — all came from the same discipline: measure, then re-measure when the world changes, then write down what could not be tested. That is the transferable part.

**It forbids assuming parity.** Codex already differs from Claude in identity model and process type. The richer `session_meta` suggests the source problem may be *easier* there, and a spec that mechanically mirrors the Claude one would miss that.
