# Public streamer deploy (Fly)

The container behind [`https://threadbase-demo.fly.dev`](https://threadbase-demo.fly.dev) — what Apple App Review and curious visitors pair against from the iOS app. Builds the **real** `tb-streamer` from local source, runs it on Linux, and serves a curated `demo-data/` corpus. No Anthropic credentials, no model calls, no real conversation history.

## Architecture

```
Fly machine (1gb, shared-cpu-1x, /data volume)
├── /opt/tb-streamer/                  real streamer (built from this repo's src/)
├── /opt/claude-code-stub/claude.js    PTY stand-in for the `claude` CLI binary
├── /usr/local/bin/claude → stub       what tb-streamer's PTYManager spawns per session
├── /seed/                             demo conversation corpus (from demo-data/ at the repo root)
└── /data/                             Fly volume, persists across deploys
    ├── .claude/projects/              seeded from /seed at boot
    └── .threadbase/server.yaml        apiKey, publicUrl, browseRoot
```

### Why a stub for `claude`?

`tb-streamer`'s `PTYManager` spawns the binary named `claude` on PATH per session. Running the real Claude Code CLI inside this container would require an Anthropic API key on a public-internet machine — rejected because of token spend, credential exposure, and the lack of per-reviewer rate limiting. The stub at `claude-code-stub/claude.js` prints the welcome banner + `❯` ready marker + scripted replies on stdin. Reviewers see a live-looking terminal; typed input gets canned answers. No model is hit.

### Why a separate /opt and /seed layout?

The streamer expects `$HOME/.claude/projects/` to hold JSONL conversation files. The image bakes the corpus at `/seed/` and the entrypoint copies it into `$HOME/.claude/projects/` on every boot (idempotently — `cp -rn` only writes paths that don't already exist on the persistent volume). That way:

- Reviewer state (renamed sessions, started PTYs, etc.) survives auto-stop / auto-start cycles via the Fly volume
- A fresh corpus addition (new JSONL in `demo-data/`) lands on the next deploy without wiping the volume

## Demo corpus

Three multi-turn conversations across three project directories under `demo-data/.claude/projects/`:

| Project | What's in it |
|---|---|
| `-home-demo-projects-threadbase-mobile` | Adding pull-to-refresh on a FlatList |
| `-home-demo-projects-personal-website` | Hero redesign with animated conic gradient |
| `-home-demo-projects-experiments` | Debugging a slow pandas groupby |

Zero real history. All file paths, project names, and code samples are fabricated. The directory names follow Claude Code's `<absolute-path-with-slashes-as-dashes>` convention.

## Deploy

From the **repo root** (not `docker/`):

```bash
git submodule update --init --recursive  # vendor/scanner must be present
fly deploy --remote-only -c docker/fly.toml
```

The Dockerfile builds `tb-streamer` from the current branch's source via `npm ci && npm run build`, so the deployed streamer always reflects the working tree.

### First-time setup (one-shot per Fly app)

```bash
fly volumes create demo_data --region iad --size 1
fly deploy --remote-only -c docker/fly.toml
```

### Reset reviewer state back to baked seed

The Fly volume persists state across deploys, so reviewer pokes (renames, started sessions, sqlite cache) carry forward. To wipe everything:

```bash
fly volumes destroy demo_data
fly volumes create demo_data --region iad --size 1
fly deploy --remote-only -c docker/fly.toml
```

## Pair an iOS / web client against it

| Field | Value |
|---|---|
| URL | `https://threadbase-demo.fly.dev` |
| API key | `tb_public_demo_reviewer_key` |

The `tb-mobile` repo's `e2e/setup-demo.yaml` Maestro flow already uses these values.

## Capabilities (and known boundaries)

| Capability | Works |
|---|---|
| Browse the seeded conversations | yes |
| Open a session and see terminal output | yes (scripted via claude-code-stub) |
| Resume a session from a conversation | yes |
| Rename a session (persists for the life of the volume) | yes |
| Send arbitrary input to a session | partial — gets scripted replies, not real Claude |
| Pair multiple servers from one client | yes, but only this one is real |
| Run real Claude Code inside the container | no — stub on PATH |

## Troubleshooting

### Session screen shows `chdir(2) failed.: No such file or directory`

**When:** A reviewer (or Maestro flow) resumes a seeded conversation, the session screen loads, but the terminal pane shows only one line:

```
1  chdir(2) failed.: No such file or directory
```

Status reads `Idle  0s  0 prompts` instead of `● Active`.

**Cause:** Every JSONL under `demo-data/` carries a `cwd` field — the absolute path of the project the conversation was recorded in (e.g. `/home/demo/projects/threadbase-mobile`). When `PTYManager` spawns `claude` for a resumed session, it passes that path as the child process's working directory. If the directory does not exist on the container, the spawn fails immediately, the PTY exits, and the streamer broadcasts the chdir error as the session's terminal output.

The directory must exist; it does not need to contain anything. `claude-code-stub` never reads from it.

**Fix:** Add the new project path to the `mkdir -p` block in `entrypoint.sh`. Every `cwd` value referenced in `demo-data/.claude/projects/*/*.jsonl` needs a matching `mkdir -p` line:

```bash
mkdir -p \
    /home/demo/projects/threadbase-mobile \
    /home/demo/projects/experiments \
    /home/demo/projects/personal-website
    # ← add the new path here
```

Redeploy and the next session resume will succeed. The directories are persisted on the Fly volume after first boot, so this only matters when a new seed conversation is introduced.

**How to find every cwd in the corpus:**

```sh
jq -r 'select(.cwd) | .cwd' demo-data/.claude/projects/*/*.jsonl | sort -u
```

### `Cannot find module 'bindings'` or `Cannot find module 'node-addon-api'` during build

**Cause:** The streamer's `package-lock.json` doesn't pin these as build-time peers (they're upstream dependencies of `better-sqlite3` and `node-pty` respectively). The Dockerfile installs both explicitly before rebuilding native modules.

**Fix:** Check that the Dockerfile's two `npm install --no-save` lines for `node-addon-api` and `bindings` are still present and run **before** `npm run install` (node-pty) and `npm run build-release` (better-sqlite3).

### Native module rebuild fails with `gyp: ... not found`

**Cause:** Apt didn't install `python3 make g++` in the builder stage.

**Fix:** Confirm the `apt-get install` line in the builder stage includes all three. The slim base image doesn't carry them by default.

## What lives where (overview)

| Concern | Location |
|---|---|
| Public streamer build + deploy machinery | `tb-streamer/docker/` *(this directory)* |
| Demo conversation fixtures | `tb-streamer/demo-data/` |
| The iOS app's pair-against-URL test flow | `tb-mobile/e2e/setup-demo.yaml` |
| The real streamer source | `tb-streamer/src/`, `tb-streamer/cli/` |
