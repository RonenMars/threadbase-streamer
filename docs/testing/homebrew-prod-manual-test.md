# Homebrew + `--prod` manual test runbook

This is a **manual, real-machine runbook** for the Homebrew install scenarios that
the automated suite cannot cover. The vitest tests mock `launchctl` / `execFile`
and the filesystem, so they verify *we issue the right commands* — not that real
`launchd` loads the service, binds the port, or that `tb-streamer prod` actually
controls a brew-managed agent. Run this top-to-bottom on a Mac to close that gap.

**PRs validated**

| PR | What this runbook checks |
|----|--------------------------|
| #69 | `tb-streamer --version` resolves on the Cellar/libexec layout (not `0.0.0+unknown`); formula service PATH includes `HOMEBREW_PREFIX/bin` so `claude` resolves |
| #70 | `tb-streamer update` on a brew install refuses with a "run `brew upgrade`" message + exit 2 (no download); corrected `brew info` caveats |
| #71 | brew service runs `serve --prod` under `homebrew.mxcl.tb-streamer`; `tb-streamer prod …` and dev-takeover resolve and control the **brew** label, not the deploy.sh label |

**Platform:** macOS only (Apple Silicon paths shown; Intel uses `/usr/local` instead
of `/opt/homebrew`). **Time:** ~15–20 min. **Reversible:** yes — see scenario 11.

Throughout, `homebrew.mxcl.tb-streamer` is the brew launchd label and
`com.ronen.threadbase` is the `scripts/deploy.sh` label.

---

## 1. Pre-reqs & safety

**Setup**
- A Mac with Homebrew installed.
- `claude` CLI installed and on PATH (`which claude` → e.g. `/opt/homebrew/bin/claude`).
- Port **8766** must be free before you start. The brew service and any
  `scripts/deploy.sh` prod instance both bind 8766 — they are **mutually
  exclusive**. If you already run a deploy.sh prod streamer, stop it first.

**Commands**
```bash
# Is anything already on 8766?
lsof -nP -iTCP:8766 -sTCP:LISTEN

# If a deploy.sh prod streamer is running, stop it (frees the port + unloads its agent):
tb-streamer prod stop            # if the CLI is already installed
# …or directly:
launchctl bootout gui/$UID/com.ronen.threadbase 2>/dev/null || true

# Confirm the port is now free:
lsof -nP -iTCP:8766 -sTCP:LISTEN || echo "8766 free"
```

**Pass criteria:** `8766 free` printed; no `com.ronen.threadbase` in
`launchctl list | grep threadbase`.

**Cleanup:** none yet. Remember whether you had a deploy.sh prod instance — scenario 11
covers restoring it.

---

## 2. Install the formula

The formula downloads per-arch release tarballs from the GitHub release URLs baked
into it, so you can only install a **version whose tarballs are actually published**
on `RonenMars/threadbase-streamer/releases`. A from-source build of an
*unpublished* version will fail at the download step (404 on the `.tgz`).

Pick **one** of (a) or (b).

### (a) Install the latest published version from the tap (recommended)

**Setup:** a stable release has been published and `RonenMars/homebrew-threadbase`
carries its formula.

```bash
brew tap RonenMars/threadbase
brew install tb-streamer
# or in one shot:
brew install RonenMars/threadbase/tb-streamer
```

### (b) Install from a local formula file (testing a specific published version)

**Setup:** you have the rendered `tb-streamer.rb` for a version whose tarballs are
published (e.g. produced by `scripts/build-formula.mjs`, or pulled from the tap repo).

```bash
# Render a formula for an already-published version X.Y.Z (tarballs must exist):
#   node scripts/build-formula.mjs --version X.Y.Z --artifacts <dir-with-tgz> --out /tmp/tb-streamer.rb
brew install --build-from-source /tmp/tb-streamer.rb
```

> Note: `--build-from-source` here just means "use this local formula file"; the
> formula still downloads the prebuilt per-arch tarball — there is no compile step.
> Installing a version whose `.tgz` assets aren't on the GitHub release will 404.

**Expected output/behavior:** install completes; `brew list tb-streamer` shows files
under `…/Cellar/tb-streamer/<version>/libexec/`.

**Pass criteria:**
```bash
brew --prefix tb-streamer            # → /opt/homebrew/Cellar/tb-streamer/<version> (or opt/ symlink)
ls "$(brew --prefix tb-streamer)/libexec/dist/cli.cjs"   # exists
which tb-streamer                    # → /opt/homebrew/bin/tb-streamer
```

**Cleanup:** scenario 11.

---

## 3. `tb-streamer --version` on the Cellar layout (PR #69)

**Setup:** formula installed (scenario 2). The formula stamps
`libexec/dist/version.txt` as `<version>+brew`, and the brew `bin/tb-streamer` is a
wrapper whose realpath resolves into `Cellar/…/libexec/dist/cli.cjs`.

**Commands**
```bash
tb-streamer --version
```

**Expected output:** the real version with a `+brew` suffix, e.g.
```
X.Y.Z+brew
```

**Pass criteria:** output is **NOT** `0.0.0+unknown` and matches the installed
Cellar version (`brew list --versions tb-streamer`). This proves `version.txt`
resolution works on the real symlink/Cellar layout.

**Cleanup:** none.

---

## 4. Start the service & confirm the brew label + `--prod` (PR #71)

**Setup:** API key set once, then start the service.

**Commands**
```bash
tb-streamer set-key tb_<32-hex-chars>      # your API key
brew services start tb-streamer

# Confirm launchd loaded the BREW label (not the deploy.sh one):
launchctl print "gui/$UID/homebrew.mxcl.tb-streamer" | head -40

# Confirm it bound 8766:
lsof -nP -iTCP:8766 -sTCP:LISTEN

# Confirm it was started WITH --prod (inspect the running args and/or the plist):
ps -Ao args | grep -- 'tb-streamer serve' | grep -v grep
plutil -p "$HOME/Library/LaunchAgents/homebrew.mxcl.tb-streamer.plist" | grep -A6 ProgramArguments
```

**Expected output/behavior:**
- `launchctl print …/homebrew.mxcl.tb-streamer` prints a service block (state
  running) — i.e. exits 0, the exact probe `resolveLoadedLabel()` relies on.
- `lsof` shows a node process LISTENing on `*:8766`.
- The `ps` line and the plist `ProgramArguments` both include `serve`, `--port`,
  `8766`, **and** `--prod`.

**Pass criteria:** brew label is loaded, port 8766 is bound, and `--prod` is present
in the launch arguments.

**Cleanup:** leave running for the next scenarios.

---

## 5. Session spawn / PATH resolves `claude` (PR #69 PATH fix)

**Setup:** service running (scenario 4). The formula's `service` block sets
`PATH` to include `HOMEBREW_PREFIX/bin`, so node-pty's `execvp("claude", …)` can
find the binary even though launchd otherwise hands services a bare PATH.

**Commands**
```bash
KEY=$(tb-streamer print-key 2>/dev/null || echo tb_<your-key>)

# Health check (sanity):
curl -fsS -H "Authorization: Bearer $KEY" http://127.0.0.1:8766/healthz; echo

# Start a session (spawns a PTY that execs `claude`):
curl -fsS -X POST http://127.0.0.1:8766/api/sessions/start \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"projectPath":"'"$HOME"'","prompt":"echo hi"}' ; echo

# Watch the service log for an ENOENT-on-claude failure (should NOT appear):
tail -n 50 "$(brew --prefix)/var/log/tb-streamer.err"
```

**Expected output/behavior:** `/healthz` returns `{ "ok": true, … }`. The session
start returns a session object (not an instant-exit failure). The error log shows
**no** `execvp`/`ENOENT`/`claude: command not found` lines.

**Pass criteria:** session starts and produces terminal output; no `claude` ENOENT
in the logs. (If `claude` ENOENTs, the PATH fix regressed.)

**Cleanup:** the test session will idle out; nothing required.

---

## 6. `tb-streamer update` is refused on a brew install (PR #70)

**Setup:** brew install present (any state). The updater detects a `/Cellar/` path
and refuses, because its file-swap under `~/.threadbase/` can't update a Cellar
binary.

**Commands**
```bash
tb-streamer update ; echo "exit=$?"
```

**Expected output:**
```
Installed via Homebrew — run `brew upgrade tb-streamer` to update.
exit=2
```

**Pass criteria:** the refusal message is printed, exit code is **2**, and **no**
download happens (no new dirs under `~/.threadbase/releases/`, no network fetch).

**Cleanup:** none.

---

## 7. `tb-streamer prod …` controls the brew service (PR #71)

**Setup:** brew service running (scenario 4). These commands must resolve the
**brew** label (`homebrew.mxcl.tb-streamer`), not `com.ronen.threadbase`.

**Commands**
```bash
# STATUS — should report the brew agent loaded + its pid:
tb-streamer prod status

# RESTART — must re-bootstrap from the BREW plist path:
tb-streamer prod restart
launchctl print "gui/$UID/homebrew.mxcl.tb-streamer" >/dev/null 2>&1 && echo "brew agent still loaded after restart"

# STOP — must bootout the brew label (frees 8766):
tb-streamer prod stop
lsof -nP -iTCP:8766 -sTCP:LISTEN || echo "8766 free after prod stop"
launchctl print "gui/$UID/homebrew.mxcl.tb-streamer" >/dev/null 2>&1 || echo "brew agent unloaded"

# START — re-loads/kickstarts the brew agent:
tb-streamer prod start
lsof -nP -iTCP:8766 -sTCP:LISTEN && echo "8766 bound again after prod start"
```

**Expected output/behavior:**
- `prod status` → `agent: loaded`, a numeric `pid`, `marker: none`.
- `prod restart` → prints `agent restarted from …/Library/LaunchAgents/homebrew.mxcl.tb-streamer.plist`
  (the **brew** plist path — this confirms `darwinPlistPath()` resolved the brew
  label *before* bootout), and the brew agent is loaded afterward.
- `prod stop` → `launchd agent unloaded`; 8766 frees; brew agent gone.
- `prod start` → `prod streamer restored …`; 8766 bound again.

**Pass criteria:** every command names/affects `homebrew.mxcl.tb-streamer`. In
particular `prod restart`'s message must reference the **homebrew.mxcl** plist, and
`prod stop` must actually free port 8766 (proving it unloaded the *real* service, not
a nonexistent deploy.sh label).

**Cleanup:** leave the brew service running (re-run `tb-streamer prod start` or
`brew services start tb-streamer` if you stopped it) for scenario 8.

---

## 8. Dev-takeover detects the brew prod (PR #71)

**Setup:** brew prod service running and bound to 8766 (end of scenario 7). Run a
*dev* streamer (no `--prod`) from a git repo directory. `detectProdActive()` →
`isAgentLoaded()` must now see the brew label and treat prod as active.

**Commands**
```bash
cd /path/to/any/git/repo
tb-streamer serve --port 8766
# (interactive prompt expected — see below; answer, then Ctrl-C to exit dev)
```

**Expected output/behavior:** because a supervised prod instance is detected as
active on 8766, the CLI prompts with the dev-vs-prod choice (e.g. "prod is running —
[r]eplace it for this dev session / use another [p]ort / cancel"). It does **not**
silently fail with `EADDRINUSE`, and it does **not** ignore the running brew prod.

- If you choose **replace**, it boots out the brew agent, writes the suspend marker,
  and binds 8766 for dev. `tb-streamer prod status` then shows `marker: dev-suspended`.
- Restore afterward with `tb-streamer prod start`.

**Pass criteria:** the prompt appears (prod detected). On replace, `prod status`
reports a `dev-suspended` marker; `prod start` cleanly restores the brew prod.

**Cleanup:**
```bash
# If you chose replace, restore the brew prod:
tb-streamer prod start
# Ensure no stale marker:
tb-streamer prod doctor --fix
```

---

## 9. `brew upgrade` — the supported update path (PR #70)

**Setup:** an older brew version installed; a newer version published to the tap.
This is the path the caveats now point users to (instead of the removed
`--enable-auto-update`).

**Commands**
```bash
brew update                      # refresh tap metadata
brew upgrade tb-streamer
tb-streamer --version            # reflects the new version
launchctl print "gui/$UID/homebrew.mxcl.tb-streamer" >/dev/null 2>&1 && echo "service re-registered"
```

**Expected output/behavior:** brew swaps the Cellar to the new version and
re-registers the service. `--version` shows the new `X.Y.Z+brew`. The service is
loaded under the same brew label and bound to 8766.

**Pass criteria:** `--version` increased to the upgraded version and the service is
running under `homebrew.mxcl.tb-streamer`.

> If only one version is available, skip the upgrade itself and just confirm
> `brew outdated tb-streamer` is empty (already latest).

**Cleanup:** none.

---

## 10. Caveats sanity (PR #70)

**Setup:** formula installed.

**Commands**
```bash
brew info tb-streamer
```

**Expected output/behavior:** the caveats section reads:
- `tb-streamer set-key <YOUR_API_KEY>`
- `brew services start tb-streamer`
- **`brew upgrade tb-streamer`** as the update step
- the mutual-exclusivity note booting out **`com.ronen.threadbase`**

**Pass criteria:** caveats mention `brew upgrade tb-streamer`; there is **no**
mention of `tb-streamer update --enable-auto-update` (that flag never existed) and
the bootout label is `com.ronen.threadbase` (not `com.threadbase.streamer`).

**Cleanup:** none.

---

## 11. Full cleanup

**Commands**
```bash
# Stop + remove the brew install:
brew services stop tb-streamer
brew uninstall tb-streamer
brew untap RonenMars/threadbase        # optional

# Confirm nothing is left bound or loaded:
lsof -nP -iTCP:8766 -sTCP:LISTEN || echo "8766 free"
launchctl print "gui/$UID/homebrew.mxcl.tb-streamer" >/dev/null 2>&1 || echo "brew agent gone"

# Clear any leftover suspend marker from dev-takeover testing:
rm -f "$HOME/.threadbase/prod-suspended.json"
```

**Restore a deploy.sh prod instance (only if you had one before scenario 1):**
```bash
# Re-load the launchd agent the deploy script installed:
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/com.ronen.threadbase.plist"
# …or re-run the deploy script's setup / `tb-streamer prod start` once the
# deploy.sh CLI is the one on PATH again.
tb-streamer prod status
```

**Pass criteria:** 8766 free and brew agent gone after uninstall; if you restored
deploy.sh prod, `prod status` shows `com.ronen.threadbase` loaded again.

---

## Quick checklist

- [ ] 1. Port 8766 free; no conflicting prod instance
- [ ] 2. `brew install` succeeds; files under `Cellar/…/libexec`
- [ ] 3. `--version` → `X.Y.Z+brew` (not `0.0.0+unknown`)
- [ ] 4. Service loaded as `homebrew.mxcl.tb-streamer`, bound 8766, `--prod` present
- [ ] 5. Session spawns; no `claude` ENOENT in logs
- [ ] 6. `tb-streamer update` refused with `brew upgrade` message, exit 2, no download
- [ ] 7. `prod status/stop/start/restart` all control the brew label; restart names the brew plist
- [ ] 8. Dev `serve` detects the brew prod and prompts
- [ ] 9. `brew upgrade` bumps version and re-registers the service
- [ ] 10. `brew info` caveats correct (brew upgrade; no fake flag; right bootout label)
- [ ] 11. Cleanup leaves 8766 free; deploy.sh prod restored if applicable
