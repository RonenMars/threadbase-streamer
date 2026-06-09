#!/usr/bin/env bash
# Bootstrap HOME with tb-streamer config, then exec the streamer.
# Idempotent: safe to run on every cold boot of the Fly machine without
# clobbering reviewer state from prior sessions (the Fly volume mounted
# at /data persists across restarts).
set -euo pipefail

mkdir -p "${HOME}/.claude/projects" "${HOME}/.threadbase"

# Demo mode setup: copy seed data and create stub project directories
# Only runs if /seed exists (DEMO_MODE=true build)
if [ -d "/seed" ]; then
    echo "Demo mode detected - copying seed data"
    # /seed is the demo-data/ directory baked into the image. Layout mirrors
    # the real $HOME layout the streamer expects, so we copy /seed/. into $HOME.
    # -n keeps existing files — Fly volume state wins over the baked seed once
    # a reviewer has paired and the streamer has rewritten its cache.
    cp -rn /seed/. "${HOME}/"

    # The seed JSONLs reference cwd paths like /home/demo/projects/threadbase-mobile.
    # When a reviewer resumes a session, tb-streamer's PTYManager spawns claude
    # with cwd set to that projectPath — if the directory does not exist, the PTY
    # exits immediately with "chdir(2) failed: No such file or directory" and the
    # session screen shows the error instead of the claude-code-stub banner.
    # Create the referenced project directories so the chdir succeeds. The
    # directories are intentionally empty; claude-code-stub does not read from them.
    mkdir -p \
        /home/demo/projects/threadbase-mobile \
        /home/demo/projects/experiments \
        /home/demo/projects/personal-website
else
    echo "Production mode detected - skipping seed data"
fi

# API key resolution: PROD_API_KEY takes precedence over DEMO_API_KEY.
# Production deployment sets PROD_API_KEY via Fly secrets; demo keeps the
# fixed public key.
#
# Fail closed in production. The public demo key (tb_public_demo_reviewer_key)
# is intentionally well-known; falling back to it in a prod image would leave
# the deployment open to anyone. /seed exists only in DEMO_MODE builds (prod
# builds rm -rf it), so its absence marks a prod image — and a prod image with
# no PROD_API_KEY must refuse to boot rather than silently go public.
if [ -n "${PROD_API_KEY:-}" ]; then
    API_KEY="${PROD_API_KEY}"
    DEFAULT_PUBLIC_URL="https://threadbase.fly.dev"
elif [ ! -d "/seed" ]; then
    echo "FATAL: production image (no /seed) requires PROD_API_KEY; refusing to fall back to the public demo key." >&2
    exit 1
else
    API_KEY="${DEMO_API_KEY:-tb_public_demo_reviewer_key}"
    DEFAULT_PUBLIC_URL="https://threadbase-demo.fly.dev"
fi

THREADBASE_PUBLIC_URL="${THREADBASE_PUBLIC_URL:-$DEFAULT_PUBLIC_URL}"

cat > "${HOME}/.threadbase/server.yaml" <<EOF
api_key: ${API_KEY}
public_url: ${THREADBASE_PUBLIC_URL}
browse_root: /data/.claude/projects
EOF
chmod 600 "${HOME}/.threadbase/server.yaml"

# CLAUDE_API_KEY (a Fly secret) is inherited by the streamer process. We do NOT
# export it as ANTHROPIC_API_KEY globally — that would leak the key into every
# child process. Instead PTYManager.buildSpawnEnv() injects it as
# ANTHROPIC_API_KEY only into the spawned `claude` env (src/pty-manager.ts).

# Default Claude model for spawned sessions. The Dockerfile sets
# CLAUDE_CODE_MODEL=claude-haiku-4-5-20251001; export it as ANTHROPIC_MODEL so
# the spawned Claude CLI picks it up. Override at runtime by setting
# CLAUDE_CODE_MODEL (e.g. via `fly secrets set CLAUDE_CODE_MODEL=…`).
if [ -n "${CLAUDE_CODE_MODEL:-}" ]; then
    export ANTHROPIC_MODEL="${CLAUDE_CODE_MODEL}"
fi

# The container runs as root (no USER directive in the Dockerfile). The real
# Claude CLI refuses `--dangerously-skip-permissions` under root/sudo unless
# IS_SANDBOX is set — and tb-streamer always spawns claude with that flag
# (see src/pty-manager.ts). Without this, every session start exits instantly
# with "--dangerously-skip-permissions cannot be used with root/sudo
# privileges" and the mobile app bounces back to the session list. The Fly
# machine is an isolated single-tenant VM, so the sandbox assertion holds.
export IS_SANDBOX=1

cd /opt/tb-streamer
exec node dist/cli.cjs serve \
    --port "${PORT}" \
    --prod \
    --no-pair-qr \
    --browse-root "/data/.claude/projects"
