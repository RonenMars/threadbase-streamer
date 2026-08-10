# Kick-off — restore the Windows diagnostic surface (#472)

Paste this into a Claude Code session at the root of a `threadbase-streamer` checkout **on the Windows machine**. It cannot be done from macOS: the failure is in how Task Scheduler launches the process, and the fix has to be observed there.

---

## The task

`tb-streamer prod logs` throws on Windows, and the supervised streamer writes no logs at all. A Windows user who hits any problem has nothing to send. Fix both, and prove it against a real supervised restart.

Work in a git worktree, not the primary checkout. Do not commit or push until I have reviewed the diff.

## What is known, verified on macOS against `main` @ `bbdb1e7`

Re-verify each on Windows rather than trusting it — the point of running this there is that the macOS reading may be wrong.

**`src/lifecycle/task-scheduler.ts:67-72`** — `getLogPaths()` throws unconditionally with "prod logs is not yet wired on Windows". Its doc comment above says the wiring needs `$installDir\logs\{stdout,stderr}.log`.

**`scripts/deploy.ps1:216-218`** — generates `launch.cmd` with **no** stdout/stderr redirection, then `launch.vbs` runs it hidden through `wscript.exe`. So output goes to a hidden console and is discarded.

**`scripts/deploy.ps1:199-200`** — creates `<installDir>\logs` and never writes to it, which is why the directory exists and is always empty. That is the tell.

**The command stays registered in Commander regardless**, so `tb-streamer prod --help` advertises `prod logs` on Windows and it always fails.

`CLAUDE.md`'s Windows notes already state the `pwsh.exe` redirect rule as though it were in place. It is not. Treat that as a docs bug to fix in the same change.

## Approach that is already agreed

From `docs/ROADMAP.md` and issue #472:

1. Rewrite the scheduled-task action to redirect inside the command string, since Task Scheduler has no native redirection: `pwsh.exe -Command "node cli.js serve ... *>> $logDir\stdout.log 2>> $logDir\stderr.log"`.
2. Map `getLogPaths()` on the Task Scheduler backend to those paths.
3. Ship the Commander platform gate regardless, so an unimplemented command is never advertised.

Do 3 first — it is small and independently correct, and it means a partial landing still improves things.

## Things that will bite

**Task Scheduler env vars do not reach a live session.** `[Environment]::SetEnvironmentVariable(..., 'User')` does not update the running environment. Read back from the registry and inline the value into the task command string. This already applies to `THREADBASE_DATABASE_URL` and `THREADBASE_INSTANCE_ID`.

**Kill anything already bound to 8766 before starting the task**, or the new task fails silently.

**Use `path.sep`, not `"/"`,** for prefix guards on `path.resolve()` output.

**Self-heal matters more than the generator.** Existing installs already have a `launch.cmd` without redirection. `deploy.ps1` has a self-heal block (it already rewrites a `launch.cmd` missing `--prod`) — extend it, or every existing Windows install stays broken after upgrading.

**Quoting through `cmd` → `wscript` → `pwsh` is the actual hard part.** Paths contain spaces (`C:\Users\...\.threadbase`). Test with a profile path that has a space in it, not just a clean one.

**Run `npm install` before anything else** on a fresh Windows checkout, or lint and build fail with "Cannot find module".

## Done looks like

- `tb-streamer prod logs` prints real content after a supervised restart, and `prod logs --clear` works without leaving the sparse-NUL state described in `docs/troubleshooting.md`.
- `<installDir>\logs\stdout.log` and `stderr.log` are non-empty after the task runs, containing the same boot lines launchd captures on macOS.
- An install created *before* this change picks up redirection after a redeploy, without manual intervention.
- On a platform where it is still unimplemented, `prod logs` is absent from `--help` rather than present and throwing.
- `npm run lint` and `npm test` pass. Tests in `__tests__/install.test.ts` lock the Windows stop-before-swap ordering — keep them green.

## Report back with

The diff, the actual log output after a supervised restart (paste it, do not describe it), confirmation that a pre-existing install self-heals, and a proposed conventional-commit message.

If any of the verified facts above turn out to be wrong on Windows, say so explicitly — that is a more useful result than a fix built on a wrong premise.

## Reference

Issue #472, `docs/ROADMAP.md` (Windows `prod logs`), `docs/troubleshooting.md`, `docs/guides/prod-dev-lifecycle.md`, `docs/guides/lifecycle-windows-test.md`.
