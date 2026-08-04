#!/usr/bin/env bash
# Bootstrap HOME with tb-streamer config, then exec the streamer.
# Idempotent: safe to run on every cold boot of the Fly machine without
# clobbering reviewer state from prior sessions (the Fly volume mounted
# at /data persists across restarts).
set -euo pipefail

# ── privilege drop ──────────────────────────────────────────────────────────
# Image builds as root so the entrypoint can chown the Fly volume on first
# mount (volumes arrive root-owned). Then we re-exec as uid 10001 (streamer).
if [ "$(id -u)" = "0" ]; then
    mkdir -p /data
    chown -R streamer:streamer /data
    if [ -d /home/demo ]; then
        chown -R streamer:streamer /home/demo
    fi
    if [ -d /seed ]; then
        chown -R streamer:streamer /seed
    fi
    exec setpriv --reuid=streamer --regid=streamer --init-groups -- "$0" "$@"
fi

mkdir -p "${HOME}/.claude/projects" "${HOME}/.threadbase"

# Browse root: prod browses the JSONL store; demo must browse the directory
# tree the seed sessions actually live in (/home/demo/projects), otherwise the
# mobile tree-view prefill sends paths the server rejects with
# "Path outside browse root" and Start Session Here always fails.
BROWSE_ROOT="/data/.claude/projects"

# Demo mode setup: copy seed data and create stub project directories.
# Only runs if /seed exists (demo image target).
if [ -d "/seed" ]; then
    echo "Demo mode detected - copying seed data"
    # /seed is the demo-data/ directory baked into the image. Layout mirrors
    # the real $HOME layout the streamer expects, so we copy /seed/. into $HOME.
    # -n keeps existing files — Fly volume state wins over the baked seed once
    # a reviewer has paired and the streamer has rewritten its cache.
    cp -rn /seed/. "${HOME}/"

    # Derive project dirs from cwd fields in the seeded JSONLs (no hardcoded
    # list — adding a seed conversation just works on next boot).
    DEMO_PROJECTS_ROOT="${HOME}/.claude/projects" \
        node /opt/tb-streamer/dist/ensure-demo-project-dirs.cjs

    BROWSE_ROOT="/home/demo/projects"
else
    echo "Production mode detected - skipping seed data"
fi

# API key resolution: PROD_API_KEY takes precedence over DEMO_API_KEY.
# Production deployment sets PROD_API_KEY via Fly secrets; demo keeps the
# fixed public key.
#
# Fail closed in production. The public demo key (tb_public_demo_reviewer_key)
# is intentionally well-known; falling back to it in a prod image would leave
# the deployment open to anyone. /seed exists only in the demo image target,
# so its absence marks a prod image — and a prod image with no PROD_API_KEY
# must refuse to boot rather than silently go public.
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

# Merge (do not overwrite) the keys the container owns. Preserves any other
# server.yaml lines that accumulated on the persistent volume.
export SERVER_YAML_PATH="${HOME}/.threadbase/server.yaml"
node /opt/tb-streamer/dist/merge-server-yaml.cjs \
    "api_key=${API_KEY}" \
    "public_url=${THREADBASE_PUBLIC_URL}" \
    "browse_root=${BROWSE_ROOT}"
chmod 600 "${SERVER_YAML_PATH}"

# Pre-clear the Claude CLI first-run gates so spawned interactive sessions reach
# a usable prompt instead of a blocking dialog (the mobile app shows an empty
# screen otherwise). dist/seed-claude-config.cjs (compiled from
# src/docker/seed-claude-config.ts) seeds $HOME/.claude.json with the flags that
# clear the onboarding/theme, workspace-trust, and custom-API-key dialogs; the
# fourth gate (Bypass Permissions warning) is avoided by launching with
# `--permission-mode dontAsk` (see src/pty-manager.ts). The merge is idempotent
# and refuses to clobber an existing-but-unreadable config — full rationale and
# unit tests live with the source. A failure here exits non-zero, so `set -e`
# aborts boot rather than starting with unseeded config.
export CLAUDE_CONFIG="${HOME}/.claude.json"
node /opt/tb-streamer/dist/seed-claude-config.cjs
chmod 600 "${CLAUDE_CONFIG}"

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

# Non-root (uid 10001) plus IS_SANDBOX: Claude CLI treats the process as an
# isolated sandbox and relaxes some safety checks that would otherwise trip on
# containerised launches. The Fly machine is an isolated single-tenant VM.
# Spawned sessions use `--permission-mode dontAsk` (see src/pty-manager.ts);
# IS_SANDBOX is defense-in-depth against a future revert to a danger flag.
export IS_SANDBOX=1

cd /opt/tb-streamer
exec node dist/cli.cjs serve \
    --port "${PORT}" \
    --prod \
    --no-pair-qr \
    --browse-root "${BROWSE_ROOT}"
