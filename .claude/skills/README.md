# Project skills

Repo-scoped skills for Claude Code. Each subdirectory is one skill, with its instructions in `SKILL.md`.

**Nothing registers them.** Claude Code discovers every `.claude/skills/<name>/SKILL.md` in the project
automatically — there is no list in `CLAUDE.md`, no settings entry, no build step. Adding a directory is
the whole installation. (This file is not a skill: discovery looks for `<dir>/SKILL.md`, so a loose
`README.md` here is ignored.)

Where `CLAUDE.md` does mention a skill — `deploy-menubar`, `setup-auto-updater` — it is giving repo
context at the place that context is needed, not registering anything. Do not add a skill to `CLAUDE.md`
just to make it visible; it already is.

## What is here

| Skill | Use it when |
|---|---|
| [`integration-branch`](integration-branch/SKILL.md) | Merging a set of open PRs into one branch to test them together, with a merge log and summary |
| [`local-deploy`](local-deploy/SKILL.md) | Building, stamping and (re)launching the streamer locally on macOS, Linux or Windows |
| [`deploy-menubar`](deploy-menubar/SKILL.md) | Building and launching the menubar Electron app from `vendor/menubar`, after the server is healthy |
| [`setup-auto-updater`](setup-auto-updater/SKILL.md) | Walking a user through enabling the in-place auto-updater on a deployed streamer |
| [`setup-cloudflare-tunnel`](setup-cloudflare-tunnel/SKILL.md) | Exposing a local streamer to tb-mobile through a Cloudflare quick-tunnel |
| [`ship`](ship/SKILL.md) | Pushing a committed branch, opening a PR, watching CI, and merging on confirmation |
| [`verify`](verify/SKILL.md) | Running the full lint + type-check + test suite before committing |

## Adding one

```
.claude/skills/<kebab-case-name>/SKILL.md
```

```markdown
---
name: <same as the directory name>
description: <what it does, then the phrasings that should trigger it>
---

# <Title>

## Step 1 — …
```

Two things decide whether a skill is any use:

- **The `description` is the trigger.** It is the only part read when deciding whether to invoke, so it
  must carry both what the skill does *and* the words a user would actually say — the existing skills end
  theirs with a list of phrasings for exactly that reason. A description that only describes gets skipped.
- **The body is executed, not read for inspiration.** Write imperative steps with the real commands. Put
  the traps inline at the step where they bite, not in a section at the end.

Conventions in this repo:

- Directory name, `name:` field, and the title all match.
- State plainly what the skill must never do (push to `main`, delete a branch, merge a PR unasked). A
  skill that writes to a remote says so at the top.
- Cite repo docs by relative path rather than restating them — `CLAUDE.md` and `docs/` stay canonical.
- Skills carrying their own templates keep them in `docs/`, not inside the skill directory, so humans can
  find them without knowing a skill exists.

Personal skills live in `~/.claude/skills/` and are discovered the same way; put a skill here only when
it is about *this* repo.
