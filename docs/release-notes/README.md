# Release notes

Milestone-level narrative changelogs for `tb-streamer`. One file per milestone, named `YYYY-MM-DD-<kebab-milestone-name>.md`.

## How this relates to `CHANGELOG.md`

The repo root has `CHANGELOG.md`, which is owned by **semantic-release** and regenerated on every release tag. It contains one line per conventional commit (`feat:`, `fix:`, etc.) and is the granular machine-friendly log.

This directory is the **wider story**. Each file here answers:

- What was the milestone actually about?
- Why does it matter to an operator deploying this version, or a mobile-client author wiring against the API?
- What's deferred to the next milestone, and why?
- Are there breaking changes or migration steps?

The two coexist deliberately. `CHANGELOG.md` keeps doing its narrow per-commit job. This directory does the wider per-milestone story. **Do not hand-edit `CHANGELOG.md`** — semantic-release will overwrite your changes on the next release.

## When release notes get written

At milestone-merge time — after the final commit for the milestone is on the feature branch, but **before** the merge-to-main PR is merged. The notes belong in the merge PR so reviewers can read them as part of the merge review.

Notes do NOT get written:

- For routine bug-fix or chore PRs that are not part of a named milestone.
- After the merge has already landed (write them ahead of the merge).
- For each PR — only for the milestone as a whole.

## Filename convention

```
docs/release-notes/YYYY-MM-DD-<kebab-milestone-name>.md
```

Example: `docs/release-notes/2026-06-04-milestone-b.md`.

The date is the merge-to-main date. The kebab slug derives from the milestone name (e.g. "Milestone C" → `milestone-c`, "Plan 4 conversation deltas" → `plan-4-conversation-deltas`).

## Template

`_template.md` is the starting skeleton — every release-notes file should mirror its section layout (What shipped, Why it matters, User-visible changes, Operator-facing additions, Breaking changes, Migration notes, Architecture, Deferred, Notable fixes, How to verify, Testing).

## PR label

Add the `milestone` label to a merge PR when the PR ships a named milestone.
