# GitHub Actions CI Design

## Decision

Add a CI workflow (`.github/workflows/ci.yml`) with three parallel jobs: lint, build, and test.

## Workflow: ci.yml

Triggers on push to `main` and pull requests.

### Job: lint (Node 20)

1. Checkout streamer
2. Clone `RonenMars/threadbase-scanner` into `../scanner`
3. Install deps (with native node-pty build tools)
4. Run `npm run lint` (tsc --noEmit + biome check)

### Job: build (Node 20)

1. Checkout streamer
2. Clone scanner into `../scanner`
3. Install deps
4. Run `npm run build`
5. Upload `dist/` as artifact

### Job: test (Node 18, 20, 22 matrix, needs lint)

1. Checkout streamer
2. Clone scanner into `../scanner`
3. Install deps
4. Run `npm test`

## Key decisions

- **node-pty built natively** — CI installs python3 + build-essential for native compilation
- **Scanner cloned from separate repo** — `git clone` into `../scanner` so `file:../scanner` link works
- **Test matrix: 18, 20, 22** — broad LTS coverage
- **Test depends on lint** — no point running tests if lint fails
- **Build runs in parallel** — independent of test, uploads artifact for potential future use
