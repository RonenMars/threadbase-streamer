# `scripts/smoke-isolated.sh`

Boots the **built** CLI (`dist/cli.cjs`) in a throwaway `HOME` on a spare port
and exercises it over HTTP, so a change can be checked against the real
bundle without touching your `~/.threadbase`, your `~/.claude`, or a running
prod streamer. CI runs it too, as the `Boot built CLI` job; it is not part of
the deploy pipeline.

## Why it exists

The vitest suite imports from `src/`. The deployed artifact is the tsup
bundle, which inlines most dependencies (`hono`, `zod`, `yaml`, …) — only
`node-pty` and `better-sqlite3` stay external. A dependency bump can pass every
test and still break the bundle, and booting `dist/cli.cjs` is the only step
that exercises it. The SQLite cache migrations are also loaded from `dist/`, so
a missing copy fails the boot here. A missing `runtime-migrations/` does *not*:
it disables session persistence silently while the server keeps serving, so
this script cannot see it (see [deploy-internals.md](deploy-internals.md)).

CI's `Smoke (macos-latest)` / `Smoke (windows-latest)` jobs are a different
thing: they run the whole vitest suite (`npm test`) and a `node-pty` load check
on macOS and Windows, with no build step and no server boot. See
[cross-platform-ci.md](../testing/cross-platform-ci.md).

## In CI

The `Boot built CLI` job (`boot-dist` in `ci.yml`) runs `scripts/smoke-isolated.sh` on
`ubuntu-latest`, Node 22, against the `dist` artifact that `Build` uploads, so it
costs a download rather than a second build. It has no job-level `if:`; its steps
follow `needs.gate.outputs.skip` like every other job. It is deliberately **not**
a required check yet: promote it after it has run clean on about ten PRs, as the
Windows smoke was. Windows is not covered — the script is bash and uses `/tmp`.

## Usage

```bash
npm run test:smoke-isolated   # builds, then runs the smoke
scripts/smoke-isolated.sh     # the smoke alone, against the existing dist/
```

`test:smoke-isolated` is `npm run build && scripts/smoke-isolated.sh`. It is
deliberately not part of `npm test`: it checks a different artifact (the
bundle, not `src/`), needs a built `dist/` and a free fixed port, and a boot
failure would be one test among thousands instead of its own named result.

It is not called `test:smoke`. That name once belonged to a local fast subset
that was mistaken for the CI `Smoke` jobs above, and `ci-workflow.test.ts`
asserts it stays unused.

| Variable | Default | Meaning |
|---|---|---|
| `SMOKE_PORT` | `8799` | Port to bind. Never use the prod port `8766`. |

Use the Node version in `.nvmrc`, as for the rest of local verification —
`better-sqlite3` is a native module and fails on an ABI mismatch.

Exit code `0` = pass, `1` = a check failed, `2` = it could not run (not built,
port already in use, fixture missing). On a failure it prints the last 15
structured server log lines before the temp `HOME` is deleted.

## What it checks

| Check | Proves |
|---|---|
| `/healthz` answers `ok: true` | The bundle starts and serves |
| No-auth `/api/conversations` is `401` | The auth middleware is wired in the bundle |
| A fixture transcript is listed | Scanner → cache → list endpoint works end to end |
| That conversation's detail is `200` | Detail lookup resolves the scanned file |
| No `error` / `ENOENT` / `unhandled` in the log | Nothing failed quietly during the run |

The fixture is `__tests__/fixtures/providers/claude-code/2.1.214/conversation.jsonl`,
copied into the throwaway `~/.claude/projects/`. The expected id is read from
the fixture's own `sessionId`, so it follows the file if the fixture changes.

## How it is isolated

A different port alone does not isolate anything — the state lives in
`~/.threadbase`, not on the port. The script sets `HOME` to a fresh directory
under `/tmp`, because `os.homedir()` follows `$HOME` and that moves everything
at once: `server.yaml`, `runtime.db`, the cache, and the `~/.claude` scanner
root.

`THREADBASE_CONFIG_DIR` is deliberately *not* used. It redirects the config
tree, but the cache (`server.ts`) and the scanner roots resolve from
`homedir()` and would still point at the real ones.

It passes `--prod` and never `--replace-prod`. `--prod` is how launchd and
systemd run the shipped artifact, and it skips the dev-takeover block in
`cli/index.ts` entirely, so no supervisor is consulted and the launchd-supervised
prod instance is left alone. It is also required on Linux: without it `serve`
calls `getSupervisor()`, which throws `lifecycle: unsupported platform linux`
(the first CI run of this smoke failed exactly that way).
The script aborts (exit `2`) rather than start if its port is taken.

`THREADBASE_INSTALL_DIR`, if set in your shell, overrides where the lifecycle
files (and `--prod`'s log cap) look, and bypasses the temp `HOME`; leave it unset.

The temp directory is under `/tmp`, not `$TMPDIR`. macOS caps a unix socket
path at 104 bytes, and `$TMPDIR` (`/var/folders/…`) plus the config path
already reaches about 112. Nothing binds that socket by default (`ptyHost` is
off), but the short path keeps the script correct if that flag is enabled.

An `EXIT` trap stops the server and deletes the directory, including on
Ctrl-C.

## What it does not cover

- **Agent sessions.** The throwaway `HOME` has no Claude login, and the script
  never starts a session, so the PTY / spawn path is not exercised. That path
  stays covered only by the (mocked) unit and integration tests.
- **Providers other than Claude Code**, and anything behind a feature flag.
- **Other platforms.** It is bash and was written and run on macOS. Windows
  needs a different harness (see [lifecycle-windows-test.md](lifecycle-windows-test.md)).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dist/cli.cjs missing` | Not built | `npm run build` |
| `port 8799 is already in use` | Another process holds it | Set `SMOKE_PORT` to a free port |
| `healthz` never answers, log shows `NODE_MODULE_VERSION` | Wrong Node for the native modules | `nvm use` (`.nvmrc`), then `npm ci` |
| `fixture … is listed` fails, everything else passes | Scanner did not pick the file up within 3 s | Re-run once; if it repeats, look at the log tail |
