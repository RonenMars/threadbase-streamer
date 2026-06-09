# Production deploy container for tb-streamer.
#
# Builds the streamer from local source on linux-x86_64, rebuilds the native
# modules (node-pty + better-sqlite3) against the target Linux runtime, and
# installs the real Claude CLI for production use.
#
# By default, this is a PRODUCTION image with real Claude CLI.
# For DEMO mode (scripted stub responses), pass --build-arg DEMO_MODE=true
#
# Build context must be the repo root, not docker/, so the Dockerfile can
# COPY the source tree. Run from the repo root:
#
#   Production: docker build -f docker/Dockerfile .
#   Demo:       docker build -f docker/Dockerfile --build-arg DEMO_MODE=true .
#
# fly.toml's [build] dockerfile = 'docker/Dockerfile' takes care of this for
# `fly deploy`.

# ─── builder ────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Submodule (vendor/scanner) must be present before `npm ci` because
# package.json depends on `file:vendor/scanner`. We rely on the build context
# already containing the initialized submodule; on Fly's remote builder the
# upload step submits the working tree as-is, so as long as the host has run
# `git submodule update --init --recursive` before `fly deploy`, vendor/
# arrives populated.
COPY package.json package-lock.json ./
COPY patches ./patches
COPY vendor ./vendor
COPY scripts ./scripts
COPY src ./src
COPY cli ./cli
COPY tsup.config.ts tsconfig.json biome.json ./

# npm ci handles patch-package + node-pty chmod + build:scanner (vendor/scanner
# npm install) via the postinstall hook. node-pty's install script falls back
# to node-gyp rebuild on platforms with no prebuild — we supply node-addon-api
# explicitly because the streamer's package-lock omits it as a build peer.
RUN npm ci --no-audit --no-fund

# Rebuild native modules against the target Linux runtime. node-pty's bundled
# prebuilds are darwin/win32 only; better-sqlite3 ships only generic prebuilds
# that may not match. Both have valid source + binding.gyp; node-gyp can
# rebuild from source given python3 + make + g++ from the apt step.
RUN cd node_modules/node-pty && npm install --no-save --no-audit --no-fund node-addon-api
RUN npm install --no-save --no-audit --no-fund bindings
RUN cd node_modules/node-pty && npm run install
RUN cd node_modules/better-sqlite3 && npm run build-release

# Bundle the streamer (tsup → dist/) and copy migrations.
RUN npm run build

# ─── runtime ────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

# Build argument to control demo vs production mode
ARG DEMO_MODE=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy only what the runtime actually needs: bundled dist/ + the (rebuilt)
# node_modules tree with native binaries for Linux.
WORKDIR /opt/tb-streamer
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Install Claude CLI based on mode:
# - Production (default): Install real Claude CLI from npm
# - Demo: Install scripted stub that returns canned responses
RUN if [ "$DEMO_MODE" = "true" ]; then \
        echo "Building DEMO mode - installing claude-code-stub"; \
        mkdir -p /opt/claude-code-stub; \
    else \
        echo "Building PRODUCTION mode - installing real Claude CLI"; \
        npm install -g @anthropic-ai/claude-code; \
    fi

# Copy demo stub (only used when DEMO_MODE=true)
COPY docker/claude-code-stub /opt/claude-code-stub
RUN if [ "$DEMO_MODE" = "true" ]; then \
        chmod +x /opt/claude-code-stub/claude.js && \
        ln -sf /opt/claude-code-stub/claude.js /usr/local/bin/claude; \
    fi

# Demo conversation corpus (only copied when DEMO_MODE=true)
COPY demo-data /seed
RUN if [ "$DEMO_MODE" != "true" ]; then \
        rm -rf /seed; \
    fi

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default Claude model for spawned sessions. entrypoint.sh exports this as
# ANTHROPIC_MODEL, which the Claude CLI honors. Override at runtime with
# `fly secrets set CLAUDE_CODE_MODEL=…` or `-e CLAUDE_CODE_MODEL=…`.
ENV HOME=/data \
    PORT=8080 \
    CLAUDE_CODE_MODEL=claude-haiku-4-5-20251001
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
