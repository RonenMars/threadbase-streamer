# Production / demo deploy container for tb-streamer (Fly.io).
#
# Multi-stage layout:
#   builder       — full npm ci, native rebuild, tsup bundle
#   runtime-base  — pruned prod node_modules + dist, non-root user, healthcheck
#   production    — real Claude CLI (pinned)
#   demo          — scripted claude stub + demo-data seed corpus
#
# Build context must be the repo root:
#
#   docker build -f docker/Dockerfile --target production .
#   docker build -f docker/Dockerfile --target demo .
#
# fly.toml / fly.prod.toml set build-target accordingly.

ARG NODE_VERSION=24.15.0

# ─── builder ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Deps layer first so source edits don't invalidate npm ci.
# prepare runs `git config core.hooksPath` — needs a repo, so git init.
# scanner/agent-types are published npm packages (no vendor/ COPY needed).
COPY package.json package-lock.json ./
COPY patches ./patches
RUN git init -q \
    && npm ci --no-audit --no-fund

# Rebuild native modules against this Linux runtime. node-pty's bundled
# prebuilds are darwin/win32 only; better-sqlite3's generic prebuilds may not
# match. Both rebuild from source given python3 + make + g++.
RUN cd /build/node_modules/node-pty && npm install --no-save --no-audit --no-fund node-addon-api \
    && cd /build && npm install --no-save --no-audit --no-fund bindings \
    && cd /build/node_modules/node-pty && npm run install \
    && cd /build/node_modules/better-sqlite3 && npm run build-release

COPY src ./src
COPY cli ./cli
COPY tsup.config.ts tsconfig.json biome.json ./

RUN npm run build \
    && npm prune --omit=dev

# ─── runtime-base ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime-base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 streamer \
    && useradd --system --uid 10001 --gid streamer \
        --home-dir /data --shell /usr/sbin/nologin streamer \
    && mkdir -p /data \
    && chown streamer:streamer /data

WORKDIR /opt/tb-streamer

# Pruned prod tree (~174 MB vs ~500 MB full) + bundled dist. Natives already
# rebuilt in the builder stage.
COPY --from=builder --chown=streamer:streamer /build/dist ./dist
COPY --from=builder --chown=streamer:streamer /build/node_modules ./node_modules
COPY --from=builder --chown=streamer:streamer /build/package.json ./package.json

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && chown streamer:streamer /entrypoint.sh

# Default Claude model for spawned sessions. entrypoint.sh exports this as
# ANTHROPIC_MODEL. Override at runtime with CLAUDE_CODE_MODEL.
ENV HOME=/data \
    PORT=8080 \
    CLAUDE_CODE_MODEL=claude-haiku-4-5-20251001 \
    NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/entrypoint.sh"]

# ─── production ─────────────────────────────────────────────────────────────
FROM runtime-base AS production

# Pin the Claude CLI so rebuilds are reproducible. Bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.221
USER root
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
# Stay root for ENTRYPOINT so the first boot can chown the Fly volume; the
# entrypoint then drops to uid 10001 via setpriv.

# ─── demo ───────────────────────────────────────────────────────────────────
FROM runtime-base AS demo

USER root
COPY --chown=streamer:streamer docker/claude-code-stub /opt/claude-code-stub
RUN chmod +x /opt/claude-code-stub/claude.js \
    && ln -sf /opt/claude-code-stub/claude.js /usr/local/bin/claude

# Seed corpus → /seed; entrypoint copies into $HOME on boot (cp -rn).
COPY --chown=streamer:streamer demo-data /seed
# Project dirs referenced by seed JSONL cwd fields are created at boot from the
# corpus; pre-create /home/demo so the non-root user can mkdir underneath.
RUN mkdir -p /home/demo && chown streamer:streamer /home/demo
