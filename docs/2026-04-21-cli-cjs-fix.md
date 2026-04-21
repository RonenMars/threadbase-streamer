# Fix: CLI output extension changed from .js to .cjs

**Date:** 2026-04-21

## Problem

The CLI entry (`cli/index.ts`) was built by tsup as CJS format but output with a `.js` extension (`dist/cli.js`). Since `package.json` declares `"type": "module"`, Node.js treated the `.js` file as ESM, causing a `ReferenceError: require is not defined in ES module scope` crash on startup.

## Fix

- `tsup.config.ts`: changed CLI `outExtension` from `.js` to `.cjs`
- `package.json`: updated `bin` field from `dist/cli.js` to `dist/cli.cjs`

The library entry (`src/index.ts`) was unaffected — it already outputs both `dist/index.js` (ESM) and `dist/index.cjs` (CJS) correctly.

## Impact

- The CLI binary path changes from `dist/cli.js` to `dist/cli.cjs`
- Any scripts or launchd plists referencing `dist/cli.js` must be updated to `dist/cli.cjs`
