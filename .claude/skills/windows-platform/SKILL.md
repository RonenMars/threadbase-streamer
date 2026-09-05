---
name: windows-platform
description: tb-streamer Windows specifics: Task Scheduler log redirection and env vars, path separators, file timestamps, submodule SSH-to-HTTPS, stale port 8766, and first-deploy npm install. Use when working on Windows support, deploy.ps1, or a Windows-only test failure.
---

# Windows Platform

Moved out of the repo root `CLAUDE.md` so it loads on demand rather than in every session.
## Windows-specific notes

**Setting up a Windows dev/deploy machine from scratch (or troubleshooting a broken one)? Start with [docs/guides/windows-setup.md](docs/guides/windows-setup.md).** It covers, in order: the Node-version pitfall, the `npm install` native-module fork-in-the-road (VS Build Tools vs. `--ignore-scripts`), the nested `@threadbase-sh/scanner` `better-sqlite3` gap, why a worktree's `.git` file breaks if copied/synced to another machine, and `deploy.ps1` usage — each with a link to the matching `docs/troubleshooting.md` entry.

- **`npm install` before first deploy** — fresh clones fail lint/build with "Cannot find module" otherwise; `prepare` patches `qrcode-terminal` (dev/source installs only) and `postinstall` fixes node-pty prebuild permissions (all installs).
- **Path separators**: use `path.sep` (not `"/"`) for prefix guards on `path.resolve()` output.
- **File timestamps**: `birthtimeMs` is unaffected by `fs.utimes()`; use `mtimeMs` for cross-platform test assertions.
- **Task Scheduler log redirection**: no native stdout/stderr redirection, and the action runs `wscript.exe` → `launch.vbs` (hidden window), so the redirection lives inside `launch.cmd` as cmd `>>`/`2>>` into `~/.threadbase/logs/{stdout,stderr}.log`. Those targets and `Supervisor.getLogPaths()` both come from `logPaths()` in `src/lifecycle/constants.ts` — a launcher written without the redirection sends every line to a hidden console nothing captures, which is what made `prod logs` unwireable. `Repair-LaunchCmd` in `scripts/deploy.ps1` rewrites any `launch.cmd` lacking `>>`.
- **Task Scheduler env vars**: `[Environment]::SetEnvironmentVariable(..., 'User')` doesn't update the live session; read back from registry and inline the value in the task command string (applies to `THREADBASE_DATABASE_URL`, `THREADBASE_INSTANCE_ID`).
- **Stale port 8766**: kill any node process already bound to 8766 before starting the task — the new task fails silently if the port is taken.
- **Submodule SSH → HTTPS**: machines without SSH keys fail `git submodule update --init`. Fix once: `git config --global url."https://github.com/".insteadOf "git@github.com:"`.

