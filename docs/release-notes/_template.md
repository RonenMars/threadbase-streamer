# <short milestone name> — <one-line tagline for tb-streamer>

**Shipped:** <YYYY-MM-DD>
**PRs:** [#<number> — <short title>](<pr-url>), [#<number> — <short title>](<pr-url>)
**Squash commit on main:** `<short-sha-or-"pending merge">`

## What shipped

<2–4 sentence prose summary of the milestone. What is the new capability or change, and where does it sit in the tb-streamer architecture (HTTP, WS, PTY, multi-agent, persistence, deploy, etc.)? Mention any feature flag that gates the new behaviour and what happens when the flag is OFF.>

## Why it matters

<One paragraph or short bullet list explaining the impact. Write for an operator deploying this version or a mobile-client author wiring against the new surface. Do NOT restate the commit log here — explain the "so what".>

- <user-facing or operator-facing benefit #1>
- <user-facing or operator-facing benefit #2>
- <user-facing or operator-facing benefit #3>

## User-visible changes

<List HTTP endpoints, WebSocket message shape changes, CLI flag additions, and anything else an external consumer can observe. Note which changes are additive vs. breaking. If a change is gated by a feature flag, say so.>

- **`<METHOD /path>`** — <what changed; request/response shape if relevant>
- **`<METHOD /path>`** — <what changed>
- **WS message shapes** — <additive fields? renamed fields? new event types?>

## Operator-facing additions

<Anything an operator needs to know to deploy or run this version. CLI flags, required env vars, new runtime guards, new error codes, storage paths, etc.>

- **CLI flag** `<--flag-name>` on `<command>` (or `<ENV_VAR>` in env).
- **Required env when <condition>:** `<ENV_VAR_1>`, `<ENV_VAR_2>`.
- **New error code / status:** `<CODE>` (HTTP <status>) returned when <condition>.
- **Storage / on-disk changes:** <path, format, migration story>.

## Breaking changes

<List each breaking change with: what broke, who is affected, and the migration path. If there are no breaking changes, write exactly:>

**None.**

## Migration notes

<For existing deployments: what to do, what to change, what to leave alone. Even if there are no breaking changes, note whether existing deployments need any operator action (env var, restart, schema migration, submodule bump, etc.).>

- <migration step or "no action needed for existing deployments">

## Architecture, in one paragraph

<One dense paragraph describing the runtime shape of what was added: which processes, which protocols, where state lives, what the request/response or signal/event flow looks like end-to-end. This is the "if I forget everything else, what's the mental model" section.>

## Deferred to <next milestone name>

<Anything that was identified in this milestone but explicitly punted to the next one. Include a one-line reason for each (e.g. "scope creep", "needs upstream change", "blocked on infrastructure"). If nothing was deferred, remove this section.>

- **<deferred item>** — <one-line reason>.
- **<deferred item>** — <one-line reason>.

## Notable fixes inside this milestone

<Bug fixes that landed as part of the milestone and are worth surfacing — root cause + fix, not just a commit-message restatement. Skip this section if no notable fixes.>

- **<short fix title>** — <symptom, root cause, fix>.
- **<short fix title>** — <symptom, root cause, fix>.

## How to verify

<Concrete verification: which test, which smoke run, which manual command. Include the date and result of the most recent run if available.>

<e.g. "End-to-end smoke covered in `docs/superpowers/specs/<spec-file>.md` exercises: <flow steps>. Final smoke run (<YYYY-MM-DD>) was green.">

## Testing

<Current `npm test` output: file count, passed, skipped, failed. Replace with the actual numbers from this milestone's main branch — do NOT copy from a previous release-notes file.>

<N> test files, **<N> passed, <N> skipped, <N> failures** on the merged main as of <YYYY-MM-DD>.
