# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on [`RonenMars/threadbase-streamer`](https://github.com/RonenMars/threadbase-streamer/issues).
Use the `gh` CLI for all operations — it infers the repo from `git remote -v` when run inside a clone.

## Format and labels are defined elsewhere — read that first

**Title format, label taxonomy, and the required issue sections are canonical in [`threadbase/docs/issue-tracker.md`](https://github.com/RonenMars/threadbase/blob/main/docs/issue-tracker.md).**
That file lives in the `threadbase` umbrella repo and governs *every* component repo.
Read it before filing, re-labelling, or re-prioritising.
Never copy those rules into this repo, invent a local variant, or add a label to only one side — see `CLAUDE.md` → "Issue tracker".

The triage-state labels are **additive** to that taxonomy, not a replacement — see [`triage-labels.md`](./triage-labels.md).

## Commands

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

`gh label list` returns 30 rows by default and this repo has more than that.
Pass `--limit 100` before concluding a label does not exist.

## Labels only this repo has

`released` and `released on @next` are applied by semantic-release (`@semantic-release/github` in `.releaserc.json`) to the issues and PRs a release covers.
`milestone` marks a merge PR whose release notes are written by hand, see `CLAUDE.md` → "Release notes".
Do not apply any of these by hand.
`duplicate`, `invalid`, `good first issue` and `help wanted` are GitHub defaults and are not used here.

## Closing and cross-repo items

Finished work closes the issue with a comment naming the PR that landed it.
Partly done or not done stays open, with a comment on what remains or why, see `CLAUDE.md` → "Issue status updates".
The usual other half of a cross-repo item is [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile/issues), and the additive server change lands first.

## Two rules that override any skill instruction

- **Comment, reply, react or review only on repos the maintainer owns, and only on issues and comments the maintainer authored.** When in doubt, report what you would have said instead of posting it.
- **Re-prioritising means editing the title too.** The `P<N>:` prefix and the priority label are two representations of one fact.

The queries that check a tracker for compliance are under "Checking compliance" in the canonical doc.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
