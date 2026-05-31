# Homebrew Tap for `tb-streamer`

**Status:** Approved (2026-05-31)
**Owner:** Ronen Mars

## Goal

Give end users a one-command install path for `tb-streamer` on macOS (and Linux via Homebrew on Linux), timed for the website launch. The bar: a user with no prior context can install, set their API key, and run the service in three commands.

## Non-goals

- Homebrew-core submission. Disqualified today by star count, semver maturity, and our auto-updater. Revisit later.
- Replacing `scripts/deploy.sh` for existing users. Homebrew is a parallel install path, not a migration.
- Bundling pairing or auto-update activation into `brew install` or `brew services start`. Both stay explicit user actions.
- Windows. No `brew` story there; Windows users keep using `deploy.ps1`.

## User-facing flow

```
brew tap RonenMars/threadbase
brew install tb-streamer
tb-streamer set-key tb_<32-hex>          # new subcommand, see §4
brew services start tb-streamer          # launchd, runs at login
tb-streamer update --enable-auto-update  # optional, opt-in
```

## Architecture

### Two repos

| Repo | Role |
|---|---|
| `RonenMars/threadbase-streamer` (this repo) | Unchanged release flow. Builds the tarball as today; new step writes the formula into the tap repo. |
| `RonenMars/homebrew-threadbase` (new) | Standalone Homebrew tap. Holds `Formula/tb-streamer.rb`. Auto-updated by the streamer's release workflow. |

Homebrew requires tap repos to be named `homebrew-<name>`. The repo is `homebrew-threadbase`; users type `brew tap RonenMars/threadbase` (Homebrew strips the prefix).

### Release flow

```
semantic-release on main
   │
   ├── builds dist/ + tarball (existing)
   ├── publishes GitHub release with threadbase-streamer-<version>.tgz (existing)
   │
   └── NEW: scripts/build-formula.mjs
            │
            ├── computes sha256 of tarball
            ├── fills scripts/templates/tb-streamer.rb.tmpl
            └── pushes Formula/tb-streamer.rb to RonenMars/homebrew-threadbase
                using HOMEBREW_TAP_TOKEN (fine-grained PAT, contents:write
                on the tap repo only)
```

Pre-releases (`next` branch) skip formula publishing. Homebrew users only see stable releases.

### Native deps

The release pipeline produces per-platform tarballs (`darwin-arm64`, `darwin-x64`, `linux-x64`, `win32-x64`). The formula uses Homebrew's `on_macos`/`on_linux` + `on_arm`/`on_intel` to pick the matching one — the user gets a tarball already built for their architecture, so there is no ABI rebuild on first run.

`better-sqlite3` and `pg` are NOT bundled in the tarball (only `node-pty` is — see `scripts/pack-platform.mjs`). The formula's `install` block runs `npm ci --omit=dev --no-audit --no-fund` inside `libexec/` to fetch them; this builds `better-sqlite3` against the user's Node 20 once during `brew install`. Expected install time: 30–60s. After install, `brew services start tb-streamer` boots clean and stays fast.

## Formula contents

`Formula/tb-streamer.rb`:

```ruby
class TbStreamer < Formula
  desc "PTY session management, WebSocket streaming, and REST API for Claude Code"
  homepage "https://github.com/RonenMars/threadbase-streamer"
  license "MIT"
  version "1.1.0"

  depends_on "node@20"

  on_macos do
    on_arm do
      url "https://github.com/RonenMars/threadbase-streamer/releases/download/v1.1.0/threadbase-streamer-1.1.0-darwin-arm64.tgz"
      sha256 "sha256_arm64_here…"
    end
    on_intel do
      url "https://github.com/RonenMars/threadbase-streamer/releases/download/v1.1.0/threadbase-streamer-1.1.0-darwin-x64.tgz"
      sha256 "sha256_darwin_x64_here…"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/RonenMars/threadbase-streamer/releases/download/v1.1.0/threadbase-streamer-1.1.0-linux-x64.tgz"
      sha256 "sha256_linux_x64_here…"
    end
  end

  def install
    libexec.install Dir["*"]

    # Tarball ships dist/, package.json, package-lock.json, and node_modules/node-pty.
    # Install the remaining production deps (better-sqlite3, pg, etc.) into libexec.
    cd libexec do
      system Formula["node@20"].opt_bin/"npm", "ci", "--omit=dev", "--no-audit", "--no-fund"
    end

    (bin/"tb-streamer").write_env_script libexec/"dist/cli.cjs",
      PATH: "#{Formula["node@20"].opt_bin}:$PATH"
  end

  service do
    run [opt_bin/"tb-streamer", "serve", "--port", "8766"]
    keep_alive true
    log_path       var/"log/tb-streamer.log"
    error_log_path var/"log/tb-streamer.err"
    environment_variables PATH: std_service_path_env
  end

  def caveats
    <<~EOS
      Next steps to finish setup:

        1. Set your API key (one-time):
           tb-streamer set-key <YOUR_API_KEY>

        2. Start the service (also starts on login):
           brew services start tb-streamer

        3. (Optional) Enable automatic updates:
           tb-streamer update --enable-auto-update

      Note: Homebrew install is mutually exclusive with the
      manual scripts/deploy.sh install. If you previously
      installed via that path, run:
        launchctl bootout gui/$UID/com.threadbase.streamer
      before starting the Homebrew service.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tb-streamer --version")
  end
end
```

### Design choices

- **`depends_on "node@20"` (minimum, not pinned).** Matches `engines.node >=18` (CLAUDE.md) and the `.nvmrc` pin. Homebrew uses any Node ≥ 20 already on the system; only installs `node@20` if none is present. Bumping to `node@24` would force a second Node install for every user not already on 24 — user-hostile.
- **`libexec/` install layout.** Standard Homebrew layout for Node CLIs. Keeps `Cellar` clean.
- **Single bin: `tb-streamer`.** Deploy scripts install both `threadbase-streamer` and `tb-streamer`; Homebrew installs only the short name. Acceptable divergence.
- **`brew services` plist generated from the `service` block.** `brew services start tb-streamer` writes `~/Library/LaunchAgents/homebrew.mxcl.tb-streamer.plist` and `launchctl bootstrap`s it. This is the start-on-login mechanism.
- **`--prod` flag NOT passed.** Homebrew installs don't participate in the prod/dev lifecycle coordination scheme (that's for users who develop on top of an installed streamer). A Homebrew-managed agent is just the prod instance, full stop.

## `tb-streamer set-key` subcommand

New CLI subcommand, shipped in the same release as the formula. Used by the caveat instructions above.

### CLI

```
tb-streamer set-key <api-key>
tb-streamer set-key            # if stdin is a TTY, prompt interactively (hidden input)
tb-streamer set-key -          # read key from stdin (pipeable)
```

### Behavior

1. Resolve config path: `~/.threadbase/server.yaml`. Create the file and parent dir if missing.
2. Validate key format. Must match `^tb_[a-f0-9]{32}$` (matches the existing `tb_<32-hex>` pairing format). On mismatch, exit 1 with `Invalid key format. Expected: tb_<32 hex chars>`.
3. Load existing YAML if present. Update the `api_key:` field in place. Preserve other keys and comments using the `yaml` lib's `Document` API (already a dep).
4. Atomic write: write `server.yaml.tmp`, `fs.renameSync` to `server.yaml`. Mode `0600`.
5. Detect a running streamer (managed launchd agent via existing `lifecycle/launchd.ts`, or non-managed process via `lifecycle/process-liveness.ts`). If detected, print:
   `Restart the service to pick up the new key: brew services restart tb-streamer`
   Do NOT auto-restart.
6. Exit 0 on success, 1 on validation or write failure.

### Files

- `cli/setKey.ts` — pure function `runSetKey(args, deps)` where `deps = { configPath, stdin, logger }`. Easy to test.
- `cli/index.ts` — wire `program.command("set-key [key]")...` into existing commander setup.
- `__tests__/set-key.test.ts` — covers:
  - Format validation rejects malformed keys
  - Creates `server.yaml` + dir when missing
  - Updates `api_key:` while preserving other YAML keys
  - Atomic write semantics (no partial file on simulated crash)
  - TTY prompt path (mocked)
  - Pipeable stdin via `-`

### Not in scope

- Key rotation/revocation — that's the pair flow's job.
- Echoing the key after set — avoid leaking to terminal scrollback.
- Live reload of the running daemon — the streamer reads the key at boot. Restart is the contract.

## Release pipeline changes

### New: `scripts/build-formula.mjs`

Inputs: `--version`, `--tarball`, `--out`. Computes the tarball SHA256 and renders `scripts/templates/tb-streamer.rb.tmpl` into the output path. Pure Node; no extra deps.

### New: `scripts/templates/tb-streamer.rb.tmpl`

The formula above with `{{VERSION}}` and `{{SHA256}}` placeholders.

### Change: `.github/workflows/release.yml`

After `semantic-release` succeeds and the tarball is uploaded as a release asset:

1. Skip if the release is a pre-release (`next` channel).
2. Download the tarball from the release URL.
3. Run `node scripts/build-formula.mjs --version $VERSION --tarball $TARBALL --out Formula/tb-streamer.rb`.
4. Clone `RonenMars/homebrew-threadbase` (shallow), copy `Formula/tb-streamer.rb`, commit `chore: tb-streamer v$VERSION`, push.
5. Auth via `HOMEBREW_TAP_TOKEN` — a fine-grained PAT scoped to `RonenMars/homebrew-threadbase` only, `contents: write`. Stored as a repo secret.

### Documentation update

`docs/release.md` (or a new section in CLAUDE.md): describes how the tap is wired, how to rotate `HOMEBREW_TAP_TOKEN`, and how to manually publish a formula update if the workflow is broken.

## Testing and rollout

### Pre-launch verification

1. Locally: `brew install --build-from-source ./Formula/tb-streamer.rb` pointing at a real release tarball.
2. `brew test tb-streamer` runs the `test do` block.
3. `brew services start tb-streamer` → `curl localhost:8766/healthz` → expect `{ ok: true }`.
4. `brew services stop tb-streamer && brew uninstall tb-streamer` → confirm clean removal. User data (`~/.threadbase/cache.db`, `server.yaml`) stays intact.

### Rollout steps

1. Create empty `RonenMars/homebrew-threadbase` repo. Add a stub README pointing back to the streamer repo. Generate `HOMEBREW_TAP_TOKEN` and add to streamer repo secrets.
2. Land in `threadbase-streamer`:
   - `cli/setKey.ts` + wiring + tests
   - `scripts/build-formula.mjs`
   - `scripts/templates/tb-streamer.rb.tmpl`
   - `.github/workflows/release.yml` update
3. Cut a release (1.2.0). Verify the formula appears in the tap repo and `Formula/tb-streamer.rb` is valid.
4. Verify install on a clean Mac (Apple Silicon and Intel if possible).
5. Add `brew install …` snippet to the website launch.

### Known limitations at launch

- **Plist collision** with `scripts/deploy.sh` installs is documented in caveats only, not detected at runtime. Tracked in `docs/BACKLOG.md`.
- **Install-time native build**: `brew install` itself takes 30–60s while `better-sqlite3` builds. After that, `tb-streamer` and `brew services start tb-streamer` are immediate.
- **Linux Homebrew** should work but is not explicitly tested. Best-effort.

## Open questions

None at design approval; none remained after implementation.

## References

- Existing release config: `.releaserc.json`, `.github/workflows/release.yml`
- Existing CLI wiring: `cli/index.ts`, `cli/launchd-entry.ts`
- Lifecycle module: `src/lifecycle/`
- API key format and pairing flow: `src/auth.ts`, `src/api/routes/pair.ts`
- Auto-update mechanism: `src/updater/`, `docs/auto-update.md`
- Backlog entry: `docs/BACKLOG.md` → "Homebrew vs `scripts/deploy.sh` plist collision"
