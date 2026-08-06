# Public streamer deploy (Fly) + local Docker

The container behind [`https://threadbase-demo.fly.dev`](https://threadbase-demo.fly.dev) — what Apple App Review and curious visitors pair against from the iOS app. Builds the **real** `tb-streamer` from local source, runs it on Linux, and serves a curated `demo-data/` corpus. No Anthropic credentials, no model calls, no real conversation history.

## Image targets

`docker/Dockerfile` is multi-stage. Final targets:

| Target | Use | Claude binary | Seed corpus |
|--------|-----|---------------|-------------|
| `demo` | App Review / public demo (`fly.toml`) | `claude-code-stub` | `/seed` from `demo-data/` |
| `production` | Cloud prod (`fly.prod.toml`) | pinned `@anthropic-ai/claude-code` | none |

Shared `runtime-base`: Node **24.15.0** (matches `.nvmrc`), pruned production `node_modules`, non-root `streamer` (uid 10001), `HEALTHCHECK` against `/healthz`.

## Architecture (demo)

```
Fly machine (1gb, shared-cpu-1x, /data volume)
├── /opt/tb-streamer/                  real streamer (built from this repo's src/)
├── /opt/claude-code-stub/claude.js    PTY stand-in for the `claude` CLI binary
├── /usr/local/bin/claude → stub       what tb-streamer's PTYManager spawns per session
├── /seed/                             demo conversation corpus (from demo-data/)
└── /data/                             Fly volume, persists across deploys (HOME)
    ├── .claude/projects/              seeded from /seed at boot
    └── .threadbase/server.yaml        api_key / public_url / browse_root (merged)
```

Runs as **non-root** (`streamer`). The entrypoint starts as root only long enough to `chown` the volume mount, then `setpriv` re-execs as uid 10001.

### Why a stub for `claude`?

`tb-streamer`'s `PTYManager` spawns the binary named `claude` on PATH per session. Running the real Claude Code CLI inside the public demo would require an Anthropic API key on a public-internet machine — rejected because of token spend, credential exposure, and the lack of per-reviewer rate limiting. The stub at `claude-code-stub/claude.js` prints the welcome banner + `❯` ready marker + scripted replies on stdin. Reviewers see a live-looking terminal; typed input gets canned answers. No model is hit.

### Why a separate /opt and /seed layout?

The streamer expects `$HOME/.claude/projects/` to hold JSONL conversation files. The demo image bakes the corpus at `/seed/` and the entrypoint copies it into `$HOME` on every boot (idempotently — `cp -rn` only writes paths that don't already exist on the persistent volume). That way:

- Reviewer state (renamed sessions, started PTYs, etc.) survives auto-stop / auto-start cycles via the Fly volume
- A fresh corpus addition (new JSONL in `demo-data/`) lands on the next deploy without wiping the volume

Project directories referenced by JSONL `cwd` fields are created automatically by `dist/ensure-demo-project-dirs.cjs` (no hardcoded `mkdir` list in the entrypoint).

## Demo corpus

Three multi-turn conversations across three project directories under `demo-data/.claude/projects/`:

| Project | What's in it |
|---|---|
| `-home-demo-projects-threadbase-mobile` | Adding pull-to-refresh on a FlatList |
| `-home-demo-projects-personal-website` | Hero redesign with animated conic gradient |
| `-home-demo-projects-experiments` | Debugging a slow pandas groupby |

Zero real history. All file paths, project names, and code samples are fabricated. The directory names follow Claude Code's `<absolute-path-with-slashes-as-dashes>` convention.

## Local Docker Compose

`docker-compose.yml` at the repo root has two services:

| Service | Profile | Purpose |
|---------|---------|---------|
| `postgres` | (default) | Local Postgres 16 for `THREADBASE_DATABASE_URL` testing |
| `streamer` | `demo` | Builds the **demo** image and serves it on `:8080` |

```bash
# Postgres only (does NOT start the streamer)
docker compose up -d postgres
# → postgresql://threadbase:threadbase@localhost:5432/threadbase

# Public-demo streamer image locally (scripted Claude stub)
docker compose --profile demo up streamer --build
```

`docker compose up` alone starts **postgres only**. The streamer is opt-in via `--profile demo` so a casual `compose up` never binds 8080 or builds the heavy image by surprise.

This is not a substitute for a host-installed `tb-streamer` with a real Claude CLI.

## Deploy (Fly)

From the **repo root** (not `docker/`):

```bash
fly deploy --remote-only                  # demo (fly.toml → target demo)
fly deploy --config fly.prod.toml --remote-only   # production target
# or: npm run deploy:fly / npm run deploy:fly -- --prod
```

Scanner/agent-types come from npm — no `git submodule update` is required for the Docker build (menubar remains a submodule but is excluded via `.dockerignore`).

### First-time setup (one-shot per Fly app)

```bash
fly volumes create demo_data --region iad --size 1
fly deploy --remote-only
```

### Reset reviewer state back to baked seed

```bash
fly volumes destroy demo_data
fly volumes create demo_data --region iad --size 1
fly deploy --remote-only
```

## Pair an iOS / web client against it

| Field | Value |
|---|---|
| URL | `https://threadbase-demo.fly.dev` |
| API key | `tb_public_demo_reviewer_key` |

The `tb-mobile` repo's `e2e/setup-demo.yaml` Maestro flow already uses these values.

## Auth model

`tb_public_demo_reviewer_key` is **not a secret**. It is the public Bearer credential for the public demo container, the same way `username: guest, password: guest` is the public credential for a kiosk login. Anything it unlocks is also public by design:

- The three hand-written fixture conversations under `demo-data/`
- The `claude-code-stub` script's canned terminal output
- The list/rename/resume affordances of a streamer with no real model behind it

The container holds **no Anthropic API key**, no real conversation history, and no user data. There is nothing to leak because there is nothing of value behind the auth wall.

The key lives directly in `docker/entrypoint.sh` (and in `e2e/setup-demo.yaml` in the tb-mobile repo) so the deploy is reproducible from a fresh clone with no out-of-band setup. If you want to rotate it for any reason:

```bash
fly secrets set DEMO_API_KEY=<new-value> -a threadbase-demo
fly deploy --remote-only
```

The entrypoint already reads `DEMO_API_KEY` from the environment first and falls back to the in-source default only when unset.

**This is the only credential in source. Real production tb-streamer installs on a user's machine generate a random `api_key` on first launch (see `src/auth.ts:loadOrCreateApiKey`) and never check it in.** Production Fly images refuse to boot without `PROD_API_KEY`.

## Capabilities (and known boundaries)

| Capability | Works |
|---|---|
| Browse the seeded conversations | yes |
| Open a session and see terminal output | yes (scripted via claude-code-stub) |
| Resume a session from a conversation | yes |
| Rename a session (persists for the life of the volume) | yes |
| Send arbitrary input to a session | partial — gets scripted replies, not real Claude |
| Pair multiple servers from one client | yes, but only this one is real |
| Run real Claude Code inside the container | demo: no — stub on PATH; production target: yes |

## Troubleshooting

### Session screen shows `chdir(2) failed.: No such file or directory`

**When:** A reviewer resumes a seeded conversation and the terminal shows only the chdir error.

**Cause:** Every JSONL under `demo-data/` carries a `cwd` field. When `PTYManager` spawns `claude`, it passes that path as the working directory.

**Fix:** Re-deploy. The entrypoint runs `ensure-demo-project-dirs.cjs` against `$HOME/.claude/projects` and creates every unique `cwd` automatically. No manual `mkdir` list to update. To inspect the corpus:

```sh
node -e '
const fs=require("fs"),path=require("path");
function walk(d,a=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?walk(p,a):p.endsWith(".jsonl")&&a.push(p)}return a}
const s=new Set();
for(const f of walk("demo-data"))for(const l of fs.readFileSync(f,"utf8").split("\n")){try{const o=JSON.parse(l);if(o.cwd)s.add(o.cwd)}catch{}}
console.log([...s].sort().join("\n"))
'
```

### `Cannot find module 'bindings'` or `Cannot find module 'node-addon-api'` during build

**Cause:** Those are build peers of `better-sqlite3` / `node-pty` and are not pinned in the streamer's lockfile.

**Fix:** Confirm the builder stage still `npm install --no-save`s both **before** `npm run install` / `build-release`.

### Native module rebuild fails with `gyp: ... not found`

**Cause:** Apt didn't install `python3 make g++` in the builder stage.

**Fix:** Confirm the builder `apt-get install` line includes all three.

## What lives where (overview)

| Concern | Location |
|---|---|
| Public streamer build + deploy machinery | `docker/` *(this directory)* |
| Demo conversation fixtures | `demo-data/` |
| Compose (postgres + optional demo streamer) | `docker-compose.yml` |
| The iOS app's pair-against-URL test flow | `tb-mobile/e2e/setup-demo.yaml` |
| The real streamer source | `src/`, `cli/` |
| Container bootstrap helpers | `src/docker/*.ts` → `dist/*.cjs` |
