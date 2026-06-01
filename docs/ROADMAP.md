# Roadmap — Threadbase Streamer

Planned features and deferred work. Not blocking. No fixed dates — these get picked up when there is a concrete need or a quiet stretch.

For bugs (work that fixes broken behavior rather than adding new behavior) see [BACKLOG.md](BACKLOG.md).

---

## Feature: keychain storage for the API key

Today the streamer's API key lives at `~/.threadbase/server.yaml` as plaintext `api_key: tb_<32hex>`, protected only by filesystem perms (`chmod 0600`). The `tb-streamer set-key` command writes through the same path. That matches the de-facto convention for CLI tools (`~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.npmrc`), but a determined local attacker — or a malicious postinstall running as the user — can read the file directly.

**Approach:** move the API key to the OS keychain (macOS Keychain via `keytar`, Windows Credential Manager, libsecret on Linux). The daemon runs as the user, so a user-scoped keychain entry is readable at boot without prompting. `loadOrCreateApiKey`, `setApiKey`, and the pairing flow each need a small adapter. `server.yaml` keeps the non-secret fields (`browse_root`, `public_url`, `cache_dir`, `tail_size`).

**Migration:** on first boot after upgrade, if `api_key:` is still in `server.yaml`, move it to the keychain and rewrite the file without the line. Keep a deprecation read-fallback for one minor version so older `tb-streamer pair` flows that wrote to YAML continue to work, then remove.

**Why not now:** a native keychain dep complicates the `pack-platform.mjs` per-arch bundle (currently only `node-pty` and `better-sqlite3` are externalized). Most CLI tools in this category ship plaintext + 0600 for the same reason. Revisit when a security review flags it, or when the streamer ships keys/secrets that are not recoverable via the pair flow.

---

## Feature: Homebrew vs `scripts/deploy.sh` plist conflict-check at startup

The Homebrew tap ships its own launchd plist (`homebrew.mxcl.tb-streamer`) via `brew services`. Users who previously installed through `scripts/deploy.sh` already have `com.threadbase.streamer.plist` (or the newer lifecycle-shim variant) bound to port 8766. Running `brew services start tb-streamer` on top will start a second agent that crashes on `EADDRINUSE` until launchd throttles it.

Shipped today: a caveats note in the formula tells users Homebrew + manual deploy are mutually exclusive. That bites the unlucky user who upgrades from manual → Homebrew without reading.

**Approach:** add a conflict check inside `tb-streamer serve` (or a dedicated `tb-streamer doctor` step) that, on startup, scans `launchctl list` for `com.threadbase.streamer*` labels other than `homebrew.mxcl.tb-streamer`. If found, exit 0 with a log line telling the user to either `launchctl bootout` the legacy agent or uninstall the Homebrew formula. Reuse the Supervisor / marker plumbing from `src/lifecycle/`. Add a matching check on Windows (Task Scheduler `Threadbase` task vs any Homebrew-equivalent — currently N/A but worth scaffolding for symmetry).

---

## Feature: forward `thinkingSignature` in the messages mapper

The scanner exposes `thinkingSignature` per message but the streamer's mapper (`src/server.ts`) does not forward it. Add it next to `thinking` / `thinkingContent`. UI work in [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile) is then a small follow-up to show a "redacted reasoning" placeholder when the signature is present but the content is empty.

---

## Feature: forward `sourceToolAssistantUUID`

Scanner extracts `sourceToolAssistantUUID` for cross-entry correlation (tool result → originating tool-use). No concrete consumer use case yet. Add forwarding when a feature needs it (e.g. a "show me the tool-use that produced this result" affordance in the mobile UI).

---

## Feature: full `SystemEntry` type forwarding (`stop_hook_summary`, `bridge_status`)

These are internal Claude Code housekeeping records. The streamer extracts `turn_duration` from this category (already forwarded as `turn_durations`) but not the rest. Forward the full type if/when an analytics or debug consumer wants it.

---

## Feature: per-image metadata (`ImageBlock` type)

The streamer currently forwards a `hasImages` boolean per message, which is sufficient for the badge UI in the mobile client. Forward per-image metadata (media type, size, dimensions) when a feature needs more than a yes/no.
