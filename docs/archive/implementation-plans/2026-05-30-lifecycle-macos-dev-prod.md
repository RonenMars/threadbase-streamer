# Streamer Lifecycle: Dev/Prod Single-Instance Coordination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace today's ad-hoc "many streamers on many ports from many builds" mess with a single supervised prod instance, plus a guarded dev-mode workflow that explicitly asks before taking over the prod port, remembers the answer per repo, and self-heals if dev crashes.

**Architecture:** A small **launchd shim** sits between launchd and the real `cli.js`. On every launchd start attempt, the shim reads `~/.threadbase/prod-suspended.json`; if the marker shows a live dev PID it exits 0 (with `KeepAlive.SuccessfulExit=false` so launchd does not respawn), if the marker shows `userHeld=true` it also exits 0, otherwise it deletes the marker (if stale) and `exec`s the real `cli.js`. `serve` learns three new flags (`--replace-prod`, `--forget`, `--forget-all`) and an interactive prompt that asks "stop prod and take the port" or "use a different port" when started by a human shell next to a running prod. A new `prod` subcommand tree (`prod start | stop | status | restart | doctor`) gives the user explicit control over the supervised instance.

**Tech Stack:** TypeScript / commander.js / Vitest / Node child_process & signals / macOS launchd / SQLite-free state (JSON marker file + git toplevel discovery via `git rev-parse --show-toplevel`).

---

## File Structure

**New files** (under `src/lifecycle/` — new module with single responsibility for prod/dev coordination):

- `src/lifecycle/marker.ts` — read / write / atomically replace `~/.threadbase/prod-suspended.json`. Pure I/O + schema validation. ~80 lines.
- `src/lifecycle/marker-schema.ts` — Zod schema + TypeScript types for the marker file. ~30 lines.
- `src/lifecycle/process-liveness.ts` — `isPidAlive(pid)` using `process.kill(pid, 0)`, plus optional `isPidOurStreamer(pid)` that checks the process exists *and* its arg list matches a streamer pattern (defends against PID reuse). ~40 lines.
- `src/lifecycle/launchd.ts` — thin wrappers around `launchctl bootout / bootstrap / kickstart / list / print` for `com.ronen.threadbase`. ~80 lines.
- `src/lifecycle/prefs.ts` — read / write `~/.threadbase/dev-prefs.json` (per-repo remembered choices, keyed by git toplevel path). ~70 lines.
- `src/lifecycle/repo.ts` — `getGitToplevel(cwd)` helper. ~20 lines.
- `src/lifecycle/dev-takeover.ts` — orchestrates the dev-side flow: detect prod, prompt or honour remembered choice, perform takeover (write marker, bootout launchd), install signal handlers, write `userHeld=true` on clean exit. ~150 lines.
- `src/lifecycle/prompt.ts` — interactive `readline` prompt used by `dev-takeover.ts` (mockable; tests inject a synchronous answer fn). ~50 lines.
- `cli/launchd-entry.ts` — the **shim**. Entry point launchd will exec on every start attempt. Reads marker, decides to exit-0 or `exec` the real `cli.js`. Built by `tsup` as `dist/launchd-entry.cjs`. ~70 lines.
- `cli/prod.ts` — the `prod` subcommand tree: `start | stop | status | restart | doctor`. ~150 lines.

**Modified files:**

- `cli/index.ts` — add `--replace-prod / --forget / --forget-all` flags to `serve`, wire dev-takeover orchestration into `serve.action`, register `prod` subcommand tree. ~80 lines added.
- `tsup.config.ts` — add second CLI entry for `launchd-entry.cjs`. ~10 lines added.
- `scripts/deploy.sh` — `write_plist()` updated to (a) point `ProgramArguments` at the shim, (b) emit `KeepAlive` as a dict with `SuccessfulExit: false`, (c) emit `ThrottleInterval: 10`. `ensure_plist_healthy()` extended with one more self-heal rule that detects the old `ProgramArguments` layout and rewrites it. ~40 lines changed.

**New test files** (mirror `src/lifecycle/` structure under `__tests__/lifecycle/`):

- `__tests__/lifecycle/marker.test.ts`
- `__tests__/lifecycle/process-liveness.test.ts`
- `__tests__/lifecycle/prefs.test.ts`
- `__tests__/lifecycle/repo.test.ts`
- `__tests__/lifecycle/dev-takeover.test.ts`
- `__tests__/lifecycle/launchd-entry.test.ts`
- `__tests__/lifecycle/prod-commands.test.ts`

Why split this way: each file has one responsibility (marker I/O vs liveness check vs launchd wrappers vs user-facing flow). Tests are file-paired with the module they cover, matching the existing `__tests__/` convention. The shim lives in `cli/` next to `cli/index.ts` to share `tsup` build config and so both ship from the same package.

---

## Constants

These names are used across multiple tasks. Defined once here so tasks can reference them without ambiguity:

```typescript
// src/lifecycle/constants.ts
export const INSTALL_DIR = process.env.THREADBASE_INSTALL_DIR ?? `${process.env.HOME}/.threadbase`;
export const MARKER_PATH = `${INSTALL_DIR}/prod-suspended.json`;
export const PREFS_PATH = `${INSTALL_DIR}/dev-prefs.json`;
export const ACTIVE_LINK = `${INSTALL_DIR}/cli.js`;
export const LAUNCHD_LABEL = "com.ronen.threadbase";
export const DEFAULT_PROD_PORT = 8766;
```

---

## Marker Schema (referenced by many tasks)

```typescript
// src/lifecycle/marker-schema.ts
import { z } from "zod";

export const MarkerSchema = z.object({
  devPid: z.number().int().positive(),
  port: z.number().int().positive(),
  repoToplevel: z.string().min(1),
  suspendedAt: z.string().datetime(),
  userHeld: z.boolean(),
  shimVersion: z.literal(1), // bump if we ever change shape
});

export type Marker = z.infer<typeof MarkerSchema>;
```

`userHeld` semantics:
- `false` at takeover time. Shim treats marker as "dev is using the port; do not start prod".
- Rewritten to `true` by dev's signal handler on clean exit (SIGINT / SIGTERM / SIGHUP / `process.on("exit")` / `uncaughtException`). Shim then refuses to auto-start prod until `tb-streamer prod start` clears the marker.

---

## Prefs Schema

```typescript
// src/lifecycle/prefs.ts (schema portion)
import { z } from "zod";

export const PrefsSchema = z.object({
  repos: z.record(
    z.string(), // git toplevel path
    z.object({
      choice: z.enum(["replace-prod", "use-port"]),
      port: z.number().int().positive().optional(), // present iff choice="use-port"
      rememberedAt: z.string().datetime(),
    }),
  ),
});

export type Prefs = z.infer<typeof PrefsSchema>;
```

---

## Tasks

> **Test discipline (applies to every task):** Each task is TDD — failing test first, run it to confirm it fails for the *expected* reason, implement minimal code, run it to confirm it passes, commit. Do not advance to the next step until the current one runs successfully.

> **Commit message format:** All commits must be `<type>(<scope>): <description>` per the repo's conventional-commit rule. Use scope `lifecycle` for everything in this plan unless otherwise noted.

> **One commit per task** unless a task explicitly splits commits.

---

### Task 1: Constants + Marker Schema (foundation)

**Files:**
- Create: `src/lifecycle/constants.ts`
- Create: `src/lifecycle/marker-schema.ts`
- Test: `__tests__/lifecycle/marker.test.ts` (schema-only assertions for now; I/O comes in Task 2)

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/marker.test.ts
import { describe, it, expect } from "vitest";
import { MarkerSchema } from "../../src/lifecycle/marker-schema";

describe("MarkerSchema", () => {
  it("accepts a valid marker", () => {
    const valid = {
      devPid: 12345,
      port: 8766,
      repoToplevel: "/Users/me/work/tb-mobile",
      suspendedAt: "2026-05-30T19:55:00.000Z",
      userHeld: false,
      shimVersion: 1,
    };
    expect(() => MarkerSchema.parse(valid)).not.toThrow();
  });

  it("rejects missing fields", () => {
    expect(() => MarkerSchema.parse({ devPid: 1 })).toThrow();
  });

  it("rejects shimVersion other than 1", () => {
    const m = {
      devPid: 1, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 2,
    };
    expect(() => MarkerSchema.parse(m)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/lifecycle/marker.test.ts`
Expected: FAIL with "Cannot find module '../../src/lifecycle/marker-schema'".

- [ ] **Step 3: Write `constants.ts`**

```typescript
// src/lifecycle/constants.ts
export const INSTALL_DIR =
  process.env.THREADBASE_INSTALL_DIR ?? `${process.env.HOME}/.threadbase`;
export const MARKER_PATH = `${INSTALL_DIR}/prod-suspended.json`;
export const PREFS_PATH = `${INSTALL_DIR}/dev-prefs.json`;
export const ACTIVE_LINK = `${INSTALL_DIR}/cli.js`;
export const LAUNCHD_LABEL = "com.ronen.threadbase";
export const DEFAULT_PROD_PORT = 8766;
```

- [ ] **Step 4: Write `marker-schema.ts`**

```typescript
// src/lifecycle/marker-schema.ts
import { z } from "zod";

export const MarkerSchema = z.object({
  devPid: z.number().int().positive(),
  port: z.number().int().positive(),
  repoToplevel: z.string().min(1),
  suspendedAt: z.string().datetime(),
  userHeld: z.boolean(),
  shimVersion: z.literal(1),
});

export type Marker = z.infer<typeof MarkerSchema>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/lifecycle/marker.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lifecycle/constants.ts src/lifecycle/marker-schema.ts __tests__/lifecycle/marker.test.ts
git commit -m "feat(lifecycle): add suspension marker schema + constants module"
```

---

### Task 2: Marker I/O — atomic read / write / delete

**Files:**
- Create: `src/lifecycle/marker.ts`
- Test: `__tests__/lifecycle/marker.test.ts` (extended)

- [ ] **Step 1: Extend the failing test**

```typescript
// __tests__/lifecycle/marker.test.ts — append these
import { readMarker, writeMarker, clearMarker } from "../../src/lifecycle/marker";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("marker I/O", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marker-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("returns null when no marker exists", () => {
    expect(readMarker()).toBeNull();
  });

  it("round-trips a marker", () => {
    const m = {
      devPid: 12345, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 1 as const,
    };
    writeMarker(m);
    expect(readMarker()).toEqual(m);
  });

  it("clearMarker removes the file", () => {
    writeMarker({
      devPid: 1, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 1,
    });
    clearMarker();
    expect(readMarker()).toBeNull();
  });

  it("readMarker returns null and logs on malformed JSON (does not throw)", () => {
    const fs = require("node:fs");
    fs.writeFileSync(`${dir}/prod-suspended.json`, "{not json");
    expect(readMarker()).toBeNull();
  });

  it("writeMarker is atomic — uses tmp + rename", () => {
    // Sanity: after write, no .tmp file is left over.
    writeMarker({
      devPid: 1, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 1,
    });
    const fs = require("node:fs");
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e: string) => e.endsWith(".tmp"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm new tests fail**

Run: `npx vitest run __tests__/lifecycle/marker.test.ts`
Expected: 5 new tests FAIL ("Cannot find module '../../src/lifecycle/marker'").

- [ ] **Step 3: Implement `marker.ts`**

```typescript
// src/lifecycle/marker.ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "../logger";
import { INSTALL_DIR, MARKER_PATH } from "./constants";
import { type Marker, MarkerSchema } from "./marker-schema";

const log = getLogger("lifecycle.marker");

export function readMarker(): Marker | null {
  if (!existsSync(MARKER_PATH)) return null;
  try {
    const raw = readFileSync(MARKER_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return MarkerSchema.parse(parsed);
  } catch (err) {
    log.warn(`marker at ${MARKER_PATH} is malformed; treating as absent`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function writeMarker(marker: Marker): void {
  MarkerSchema.parse(marker); // throw early on programmer error
  mkdirSync(dirname(MARKER_PATH), { recursive: true });
  const tmp = `${MARKER_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, MARKER_PATH); // atomic on POSIX
}

export function clearMarker(): void {
  if (existsSync(MARKER_PATH)) rmSync(MARKER_PATH);
}

export function _markerPathForTests(): string {
  return MARKER_PATH;
}
```

Note: `INSTALL_DIR` is read at module-load time from `process.env.THREADBASE_INSTALL_DIR`. Tests set the env var **before** importing this module. Vitest's default `pool: "forks", singleFork: true` (per existing `vitest.config.ts`) means env mutations in `beforeEach` apply correctly because `INSTALL_DIR` is re-evaluated per fresh import — **but** the constants module caches at first import. To make tests reliable, re-export the constants as getters:

Actually, simpler fix: change `constants.ts` to use getter functions for path constants instead of string consts. Update:

```typescript
// src/lifecycle/constants.ts (revised — only paths become functions)
export const LAUNCHD_LABEL = "com.ronen.threadbase";
export const DEFAULT_PROD_PORT = 8766;

export function installDir(): string {
  return process.env.THREADBASE_INSTALL_DIR ?? `${process.env.HOME}/.threadbase`;
}
export function markerPath(): string {
  return `${installDir()}/prod-suspended.json`;
}
export function prefsPath(): string {
  return `${installDir()}/dev-prefs.json`;
}
export function activeLink(): string {
  return `${installDir()}/cli.js`;
}
```

And update `marker.ts` to call `markerPath()` instead of `MARKER_PATH`. This makes the test env override work cleanly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/lifecycle/marker.test.ts`
Expected: PASS — 8 tests total (3 schema + 5 I/O).

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/marker.ts src/lifecycle/constants.ts __tests__/lifecycle/marker.test.ts
git commit -m "feat(lifecycle): add atomic marker I/O for prod-suspended state"
```

---

### Task 3: Process liveness check

**Files:**
- Create: `src/lifecycle/process-liveness.ts`
- Test: `__tests__/lifecycle/process-liveness.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/process-liveness.test.ts
import { describe, it, expect } from "vitest";
import { isPidAlive } from "../../src/lifecycle/process-liveness";

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for PID 999999 (almost certainly absent)", () => {
    expect(isPidAlive(999999)).toBe(false);
  });

  it("returns false for negative / zero PIDs", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/process-liveness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/lifecycle/process-liveness.ts
/**
 * POSIX trick: kill(pid, 0) sends no signal but throws ESRCH if no such PID,
 * EPERM if the PID exists but is owned by another user. Either way the
 * process exists; ESRCH alone means dead.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // exists, just not ours
  }
}
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run __tests__/lifecycle/process-liveness.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/process-liveness.ts __tests__/lifecycle/process-liveness.test.ts
git commit -m "feat(lifecycle): add PID liveness check helper"
```

---

### Task 4: Repo discovery (`getGitToplevel`)

**Files:**
- Create: `src/lifecycle/repo.ts`
- Test: `__tests__/lifecycle/repo.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/repo.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getGitToplevel } from "../../src/lifecycle/repo";

describe("getGitToplevel", () => {
  it("returns null when cwd is not in a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-test-"));
    try {
      expect(getGitToplevel(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the toplevel path inside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const sub = join(dir, "sub", "deep");
      mkdirSync(sub, { recursive: true });
      // realpath because macOS /tmp is symlinked to /private/tmp
      const expected = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: sub })
        .toString().trim();
      expect(getGitToplevel(sub)).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/lifecycle/repo.ts
import { execFileSync } from "node:child_process";

export function getGitToplevel(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run __tests__/lifecycle/repo.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/repo.ts __tests__/lifecycle/repo.test.ts
git commit -m "feat(lifecycle): add git toplevel discovery helper"
```

---

### Task 5: Prefs storage (per-repo remembered choice)

**Files:**
- Create: `src/lifecycle/prefs.ts`
- Test: `__tests__/lifecycle/prefs.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/prefs.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPrefs, writePrefForRepo, forgetRepo, forgetAll, getPrefForRepo,
} from "../../src/lifecycle/prefs";

describe("prefs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prefs-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("readPrefs returns empty when no file exists", () => {
    expect(readPrefs()).toEqual({ repos: {} });
  });

  it("writePrefForRepo + getPrefForRepo round-trip 'use-port' choice", () => {
    writePrefForRepo("/repo/a", { choice: "use-port", port: 9001 });
    const pref = getPrefForRepo("/repo/a");
    expect(pref?.choice).toBe("use-port");
    expect(pref?.port).toBe(9001);
    expect(pref?.rememberedAt).toBeDefined();
  });

  it("writePrefForRepo 'replace-prod' has no port", () => {
    writePrefForRepo("/repo/b", { choice: "replace-prod" });
    expect(getPrefForRepo("/repo/b")?.port).toBeUndefined();
  });

  it("forgetRepo removes only that repo's entry", () => {
    writePrefForRepo("/repo/a", { choice: "replace-prod" });
    writePrefForRepo("/repo/b", { choice: "use-port", port: 9001 });
    forgetRepo("/repo/a");
    expect(getPrefForRepo("/repo/a")).toBeNull();
    expect(getPrefForRepo("/repo/b")).not.toBeNull();
  });

  it("forgetAll wipes everything", () => {
    writePrefForRepo("/repo/a", { choice: "replace-prod" });
    writePrefForRepo("/repo/b", { choice: "use-port", port: 9001 });
    forgetAll();
    expect(readPrefs()).toEqual({ repos: {} });
  });

  it("returns null pref when no repo path given (e.g. not in git)", () => {
    expect(getPrefForRepo(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/prefs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lifecycle/prefs.ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { getLogger } from "../logger";
import { prefsPath } from "./constants";

const log = getLogger("lifecycle.prefs");

export const PrefsSchema = z.object({
  repos: z.record(
    z.string(),
    z.object({
      choice: z.enum(["replace-prod", "use-port"]),
      port: z.number().int().positive().optional(),
      rememberedAt: z.string().datetime(),
    }),
  ),
});

export type Prefs = z.infer<typeof PrefsSchema>;
export type RepoChoice =
  | { choice: "replace-prod" }
  | { choice: "use-port"; port: number };

export function readPrefs(): Prefs {
  const path = prefsPath();
  if (!existsSync(path)) return { repos: {} };
  try {
    return PrefsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    log.warn(`prefs at ${path} are malformed; treating as empty`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { repos: {} };
  }
}

function savePrefs(p: Prefs): void {
  const path = prefsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writePrefForRepo(repoToplevel: string, choice: RepoChoice): void {
  const p = readPrefs();
  p.repos[repoToplevel] = {
    ...choice,
    rememberedAt: new Date().toISOString(),
  };
  savePrefs(p);
}

export function getPrefForRepo(repoToplevel: string | null) {
  if (!repoToplevel) return null;
  return readPrefs().repos[repoToplevel] ?? null;
}

export function forgetRepo(repoToplevel: string): void {
  const p = readPrefs();
  delete p.repos[repoToplevel];
  savePrefs(p);
}

export function forgetAll(): void {
  const path = prefsPath();
  if (existsSync(path)) rmSync(path);
}
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run __tests__/lifecycle/prefs.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/prefs.ts __tests__/lifecycle/prefs.test.ts
git commit -m "feat(lifecycle): add per-repo dev-pref storage"
```

---

### Task 6: launchd wrappers

**Files:**
- Create: `src/lifecycle/launchd.ts`
- Test: `__tests__/lifecycle/launchd.test.ts`

These wrappers are thin around `execFileSync` calls. Tests mock `child_process.execFileSync` rather than hitting real launchd (CI won't have the agent loaded).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/launchd.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock must be hoisted before the import-under-test.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  isAgentLoaded, bootoutAgent, bootstrapAgent, kickstartAgent,
} from "../../src/lifecycle/launchd";

describe("launchd wrappers", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("isAgentLoaded returns true when launchctl list exits 0", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    expect(isAgentLoaded()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["list", "com.ronen.threadbase"],
      expect.any(Object),
    );
  });

  it("isAgentLoaded returns false when launchctl list throws", () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not loaded"); });
    expect(isAgentLoaded()).toBe(false);
  });

  it("bootoutAgent swallows 'not loaded' errors", () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not loaded"); });
    expect(() => bootoutAgent()).not.toThrow();
  });

  it("bootstrapAgent passes the plist path", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    bootstrapAgent("/path/to/plist");
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["bootstrap", expect.stringMatching(/^gui\/\d+$/), "/path/to/plist"],
      expect.any(Object),
    );
  });

  it("kickstartAgent uses -k flag", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    kickstartAgent();
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["kickstart", "-k", expect.stringMatching(/^gui\/\d+\/com\.ronen\.threadbase$/)],
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/launchd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/lifecycle/launchd.ts
import { execFileSync } from "node:child_process";
import { LAUNCHD_LABEL } from "./constants";

function uidScope(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function fullTarget(): string {
  return `${uidScope()}/${LAUNCHD_LABEL}`;
}

export function isAgentLoaded(): boolean {
  try {
    execFileSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function bootoutAgent(): void {
  try {
    execFileSync("launchctl", ["bootout", fullTarget()], { stdio: "ignore" });
  } catch {
    // already unloaded — fine
  }
}

export function bootstrapAgent(plistPath: string): void {
  execFileSync("launchctl", ["bootstrap", uidScope(), plistPath], { stdio: "ignore" });
}

export function kickstartAgent(): void {
  execFileSync("launchctl", ["kickstart", "-k", fullTarget()], { stdio: "ignore" });
}

/** Returns the current PID of the supervised agent, or null. */
export function getAgentPid(): number | null {
  try {
    const out = execFileSync("launchctl", ["list"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString();
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[2] === LAUNCHD_LABEL) {
        const pid = Number.parseInt(parts[0] ?? "", 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run __tests__/lifecycle/launchd.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/launchd.ts __tests__/lifecycle/launchd.test.ts
git commit -m "feat(lifecycle): add launchctl wrapper module"
```

---

### Task 7: The shim — `cli/launchd-entry.ts`

**Files:**
- Create: `cli/launchd-entry.ts`
- Modify: `tsup.config.ts` (add the shim as a build entry)
- Test: `__tests__/lifecycle/launchd-entry.test.ts`

The shim is the central decision point. Behaviour table:

| Marker state | shim action |
|---|---|
| absent | `exec` real `cli.js` |
| present, malformed | delete + `exec` real `cli.js` (treat as absent; logged in `readMarker`) |
| present, `userHeld: true` | log "prod is user-held; skipping start", exit 0 |
| present, `userHeld: false`, `devPid` alive | log "prod suspended by dev pid X", exit 0 |
| present, `userHeld: false`, `devPid` dead | log "auto-restoring after dev crash", delete marker, `exec` real `cli.js` |

`exec` is implemented with `child_process.spawn(..., { stdio: "inherit", detached: false })` then `process.exit` waiting on the child — pure `execvp` isn't available in Node, but `spawn` with inherited stdio is functionally equivalent for launchd's purposes (the shim's PID stays the supervised PID until it exits, then launchd sees the child exit code).

Actually, **better**: use Node's `child_process.spawnSync` so the shim's lifetime exactly matches the child's, and launchd sees the same exit code. The shim becomes effectively transparent.

- [ ] **Step 1: Write the failing test**

The shim's `main()` needs to be testable in isolation — extract decision logic into a pure function. Test layout:

```typescript
// __tests__/lifecycle/launchd-entry.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideShimAction } from "../../cli/launchd-entry";
import { writeMarker, clearMarker } from "../../src/lifecycle/marker";

describe("decideShimAction", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shim-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("absent marker → exec", () => {
    expect(decideShimAction()).toEqual({ kind: "exec" });
  });

  it("userHeld=true → exit", () => {
    writeMarker({
      devPid: 1, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: true, shimVersion: 1,
    });
    expect(decideShimAction()).toEqual({ kind: "exit", reason: "user-held" });
  });

  it("dev pid alive (current process) → exit", () => {
    writeMarker({
      devPid: process.pid, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 1,
    });
    expect(decideShimAction()).toEqual({ kind: "exit", reason: "dev-alive" });
  });

  it("dev pid dead → clear marker + exec (auto-restore)", () => {
    writeMarker({
      devPid: 999999, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 1,
    });
    const action = decideShimAction();
    expect(action).toEqual({ kind: "exec", reason: "crash-recovery" });
    // Side effect: marker should be cleared.
    const { readMarker } = require("../../src/lifecycle/marker");
    expect(readMarker()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/launchd-entry.test.ts`
Expected: FAIL — `cli/launchd-entry.ts` doesn't exist.

- [ ] **Step 3: Implement `cli/launchd-entry.ts`**

```typescript
// cli/launchd-entry.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { activeLink } from "../src/lifecycle/constants";
import { getLogger } from "../src/logger";
import { clearMarker, readMarker } from "../src/lifecycle/marker";
import { isPidAlive } from "../src/lifecycle/process-liveness";

const log = getLogger("launchd-entry");

export type ShimAction =
  | { kind: "exec"; reason?: "crash-recovery" }
  | { kind: "exit"; reason: "user-held" | "dev-alive" };

/**
 * Pure decision (plus marker-clear side effect on crash recovery so the
 * caller doesn't have to). Exported for tests.
 */
export function decideShimAction(): ShimAction {
  const marker = readMarker();
  if (!marker) return { kind: "exec" };

  if (marker.userHeld) {
    return { kind: "exit", reason: "user-held" };
  }

  if (isPidAlive(marker.devPid)) {
    return { kind: "exit", reason: "dev-alive" };
  }

  // Dev died without rewriting userHeld. Auto-restore.
  clearMarker();
  return { kind: "exec", reason: "crash-recovery" };
}

function main(): void {
  const action = decideShimAction();
  if (action.kind === "exit") {
    log.info(`shim exiting (${action.reason}); launchd will not respawn (SuccessfulExit=false)`);
    process.exit(0);
  }

  if (action.reason === "crash-recovery") {
    log.info("dev crash detected — auto-restoring prod streamer");
  }

  const target = activeLink();
  if (!existsSync(target)) {
    log.error(`active link missing: ${target}`);
    process.exit(1);
  }

  // Forward all argv (launchd passes "serve --port 8766 --verbose" or whatever
  // the plist declares) straight to the real binary.
  const args = process.argv.slice(2);
  const result = spawnSync(process.execPath, [target, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    log.error(`failed to spawn ${target}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// Don't run main() when imported by tests (Vitest sets NODE_ENV=test).
if (require.main === module) {
  main();
}
```

- [ ] **Step 4: Modify `tsup.config.ts` to build the shim**

Replace the second entry block in `tsup.config.ts` with:

```typescript
  {
    entry: { cli: "cli/index.ts", "launchd-entry": "cli/launchd-entry.ts" },
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    outDir: "dist",
    external: ["node-pty", "better-sqlite3"],
    noExternal: [/^(?!node-pty|better-sqlite3).*/],
    splitting: false,
    outExtension: () => ({ js: ".cjs" }),
    define: { __VERSION__: JSON.stringify(version) },
    esbuildOptions: silenceImportMetaWarning,
  },
```

(Only the `entry` key changes; everything else stays.)

- [ ] **Step 5: Verify the build produces the new bundle**

Run: `npm run build 2>&1 | tail -10`
Expected: bundle list includes `dist/launchd-entry.cjs`.

- [ ] **Step 6: Run shim tests to verify passing**

Run: `npx vitest run __tests__/lifecycle/launchd-entry.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add cli/launchd-entry.ts tsup.config.ts __tests__/lifecycle/launchd-entry.test.ts
git commit -m "feat(lifecycle): add launchd shim that gates prod startup on suspension marker"
```

---

### Task 8: Dev-takeover orchestrator

**Files:**
- Create: `src/lifecycle/dev-takeover.ts`
- Create: `src/lifecycle/prompt.ts`
- Test: `__tests__/lifecycle/dev-takeover.test.ts`

This module owns the dev-side flow:
1. Determine `repoToplevel`.
2. Detect whether prod is running (check `isAgentLoaded()` + can-bind-port).
3. If no conflict → just start dev on requested port.
4. If conflict → look up `getPrefForRepo(repoToplevel)`. If present and not `--forget`, honour silently. Else `promptConflict()` and store via `writePrefForRepo` if user opts to remember.
5. If choice is `replace-prod`: `bootoutAgent()`, `writeMarker({userHeld:false, devPid:pid, port, ...})`, install signal handlers that rewrite `userHeld=true` on clean exit.
6. If choice is `use-port`: pick the alt port (suggest `prodPort + 1`, walk forward to first free).

The prompt is in its own file so it can be mocked.

- [ ] **Step 1: Write the failing tests**

```typescript
// __tests__/lifecycle/dev-takeover.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDevPlan } from "../../src/lifecycle/dev-takeover";

describe("resolveDevPlan", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "takeover-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("no conflict → use requested port", async () => {
    const plan = await resolveDevPlan({
      requestedPort: 9999,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => false,
      portInUse: () => false,
      prompt: vi.fn(),
      findFreePort: vi.fn(),
    });
    expect(plan).toEqual({ kind: "use-port", port: 9999 });
  });

  it("--replace-prod flag wins over everything", async () => {
    const plan = await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: true,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt: vi.fn(),
      findFreePort: vi.fn(),
    });
    expect(plan).toEqual({ kind: "replace-prod", port: 8766 });
  });

  it("conflict + no remembered pref → calls prompt", async () => {
    const prompt = vi.fn().mockResolvedValue({ choice: "use-port", port: 9001, remember: false });
    const plan = await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: () => 9001,
    });
    expect(prompt).toHaveBeenCalled();
    expect(plan).toEqual({ kind: "use-port", port: 9001 });
  });

  it("conflict + remembered 'use-port' pref → honours silently", async () => {
    const { writePrefForRepo } = await import("../../src/lifecycle/prefs");
    writePrefForRepo("/repo/a", { choice: "use-port", port: 9123 });

    const prompt = vi.fn();
    const plan = await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: vi.fn(),
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(plan).toEqual({ kind: "use-port", port: 9123 });
  });

  it("--forget clears the repo pref and re-prompts", async () => {
    const { writePrefForRepo, getPrefForRepo } = await import("../../src/lifecycle/prefs");
    writePrefForRepo("/repo/a", { choice: "use-port", port: 9123 });

    const prompt = vi.fn().mockResolvedValue({ choice: "replace-prod", remember: false });
    await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: true,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: vi.fn(),
    });
    expect(prompt).toHaveBeenCalled();
    expect(getPrefForRepo("/repo/a")).toBeNull(); // forgotten before prompt
  });

  it("prompt remember=true persists the choice", async () => {
    const prompt = vi.fn().mockResolvedValue({ choice: "use-port", port: 9001, remember: true });
    await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: "/repo/a",
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: () => 9001,
    });
    const { getPrefForRepo } = await import("../../src/lifecycle/prefs");
    expect(getPrefForRepo("/repo/a")).toMatchObject({ choice: "use-port", port: 9001 });
  });

  it("conflict + null repo (not in git) → still prompts but cannot remember", async () => {
    const prompt = vi.fn().mockResolvedValue({ choice: "use-port", port: 9001, remember: true });
    const plan = await resolveDevPlan({
      requestedPort: 8766,
      replaceProd: false,
      forget: false,
      forgetAll: false,
      repoToplevel: null,
      isProdActive: () => true,
      portInUse: () => true,
      prompt,
      findFreePort: () => 9001,
    });
    expect(plan).toEqual({ kind: "use-port", port: 9001 });
    // No repo path → nothing to persist; verify prefs file was not created.
    const { existsSync } = require("node:fs");
    const { prefsPath } = require("../../src/lifecycle/constants");
    expect(existsSync(prefsPath())).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/dev-takeover.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lifecycle/prompt.ts`**

```typescript
// src/lifecycle/prompt.ts
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export type PromptResult =
  | { choice: "replace-prod"; remember: boolean }
  | { choice: "use-port"; port: number; remember: boolean };

export type PromptFn = (opts: {
  prodPort: number;
  suggestedAltPort: number;
}) => Promise<PromptResult>;

export const interactivePrompt: PromptFn = async ({ prodPort, suggestedAltPort }) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      `\nProd streamer is running on port ${prodPort}.\n` +
        `  [r] Stop prod and take port ${prodPort}\n` +
        `  [p] Run dev on port ${suggestedAltPort} instead\n`,
    );
    const choiceAns = (await rl.question("Choice [r/p]: ")).trim().toLowerCase();
    const rememberAns = (await rl.question("Remember this choice for this repo? [y/N]: "))
      .trim()
      .toLowerCase();
    const remember = rememberAns === "y" || rememberAns === "yes";

    if (choiceAns === "r") {
      return { choice: "replace-prod", remember };
    }
    return { choice: "use-port", port: suggestedAltPort, remember };
  } finally {
    rl.close();
  }
};
```

- [ ] **Step 4: Implement `src/lifecycle/dev-takeover.ts`**

```typescript
// src/lifecycle/dev-takeover.ts
import { createServer } from "node:net";
import { writeMarker, readMarker, clearMarker } from "./marker";
import {
  forgetAll, forgetRepo, getPrefForRepo, writePrefForRepo,
} from "./prefs";
import type { PromptFn, PromptResult } from "./prompt";
import { isAgentLoaded, bootoutAgent } from "./launchd";
import { getLogger } from "../logger";

const log = getLogger("lifecycle.dev-takeover");

export type DevPlan =
  | { kind: "use-port"; port: number }
  | { kind: "replace-prod"; port: number };

export type ResolveDevPlanOpts = {
  requestedPort: number;
  replaceProd: boolean;
  forget: boolean;
  forgetAll: boolean;
  repoToplevel: string | null;
  isProdActive: () => boolean;
  portInUse: (port: number) => boolean;
  prompt: PromptFn;
  findFreePort: (start: number) => number;
};

export async function resolveDevPlan(opts: ResolveDevPlanOpts): Promise<DevPlan> {
  if (opts.forgetAll) forgetAll();
  if (opts.forget && opts.repoToplevel) forgetRepo(opts.repoToplevel);

  // Explicit flag overrides everything.
  if (opts.replaceProd) {
    return { kind: "replace-prod", port: opts.requestedPort };
  }

  const prodActive = opts.isProdActive();
  const portTaken = opts.portInUse(opts.requestedPort);
  if (!prodActive && !portTaken) {
    return { kind: "use-port", port: opts.requestedPort };
  }

  // Conflict path. Honour remembered choice if not --forget.
  if (!opts.forget) {
    const pref = getPrefForRepo(opts.repoToplevel);
    if (pref) {
      if (pref.choice === "replace-prod") {
        return { kind: "replace-prod", port: opts.requestedPort };
      }
      if (pref.choice === "use-port" && pref.port) {
        return { kind: "use-port", port: pref.port };
      }
    }
  }

  const suggested = opts.findFreePort(opts.requestedPort + 1);
  const answer = await opts.prompt({ prodPort: opts.requestedPort, suggestedAltPort: suggested });

  if (answer.remember && opts.repoToplevel) {
    if (answer.choice === "replace-prod") {
      writePrefForRepo(opts.repoToplevel, { choice: "replace-prod" });
    } else {
      writePrefForRepo(opts.repoToplevel, { choice: "use-port", port: answer.port });
    }
  }

  return answer.choice === "replace-prod"
    ? { kind: "replace-prod", port: opts.requestedPort }
    : { kind: "use-port", port: answer.port };
}

// Real I/O helpers used by cli/index.ts; kept here so they're collocated.
export function detectProdActive(): boolean {
  return isAgentLoaded();
}

export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}

export function findFreePortSync(start: number): number {
  // Synchronous best-effort: tries up to 50 ports. Returns first one whose
  // bind succeeds. Falls back to `start` if nothing free (caller will see the
  // EADDRINUSE later anyway).
  const { execFileSync } = require("node:child_process");
  for (let p = start; p < start + 50; p++) {
    try {
      execFileSync("lsof", ["-iTCP:" + p, "-sTCP:LISTEN", "-P"], { stdio: "ignore" });
      // exit 0 = something is listening
    } catch {
      return p; // lsof exit nonzero = port free
    }
  }
  return start;
}

/**
 * Acquire the prod port from launchd. Writes marker, unloads agent, installs
 * signal handlers that flip userHeld=true on clean exit (so launchd's shim
 * stays out until `tb-streamer prod start`).
 *
 * Returns a release fn for callers that want to restore prod manually.
 */
export function takeoverProd(opts: { port: number; repoToplevel: string | null }): void {
  const existing = readMarker();
  if (existing) {
    throw new Error(
      `prod is already suspended by dev pid ${existing.devPid} (since ${existing.suspendedAt}). ` +
        `Stop that dev session first, or run 'tb-streamer prod doctor'.`,
    );
  }

  bootoutAgent();
  writeMarker({
    devPid: process.pid,
    port: opts.port,
    repoToplevel: opts.repoToplevel ?? "(no-repo)",
    suspendedAt: new Date().toISOString(),
    userHeld: false,
    shimVersion: 1,
  });

  const flipUserHeld = () => {
    const m = readMarker();
    if (m && m.devPid === process.pid) {
      writeMarker({ ...m, userHeld: true });
      log.info(
        `prod is suspended (userHeld). Run 'tb-streamer prod start' to restore the supervised instance.`,
      );
    }
  };

  process.on("SIGINT", () => { flipUserHeld(); process.exit(0); });
  process.on("SIGTERM", () => { flipUserHeld(); process.exit(0); });
  process.on("SIGHUP", () => { flipUserHeld(); process.exit(0); });
  process.on("uncaughtException", (err) => {
    flipUserHeld();
    log.error(`uncaught: ${err.message}`);
    process.exit(1);
  });
  process.on("exit", () => { flipUserHeld(); });
}
```

- [ ] **Step 5: Run to verify passing**

Run: `npx vitest run __tests__/lifecycle/dev-takeover.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lifecycle/dev-takeover.ts src/lifecycle/prompt.ts __tests__/lifecycle/dev-takeover.test.ts
git commit -m "feat(lifecycle): add dev-takeover orchestrator with prompt + prefs integration"
```

---

### Task 9: Wire `serve` flags + takeover into `cli/index.ts`

**Files:**
- Modify: `cli/index.ts` (add flags, integrate `resolveDevPlan` + `takeoverProd`)
- Test: covered by manual run + integration test in Task 12 (no unit test for the wiring itself — it's glue)

- [ ] **Step 1: Add flags to the `serve` command**

In `cli/index.ts`, inside the `.command("serve")` chain, add after the existing options (around line 33):

```typescript
  .option("--replace-prod", "Stop the launchd-supervised prod streamer and bind its port", false)
  .option(
    "--forget",
    "Clear this repo's remembered dev-vs-prod choice and re-prompt",
    false,
  )
  .option("--forget-all", "Clear every repo's remembered dev-vs-prod choice", false)
  .option(
    "--prod",
    "Run as if invoked by launchd: skip the dev-takeover prompt and signal handlers",
    false,
  )
```

- [ ] **Step 2: Update the action to call `resolveDevPlan`**

Replace the existing `.action(async (opts) => {...})` body with:

```typescript
  .action(async (opts) => {
    const requestedPort = Number.parseInt(opts.port, 10);
    const apiKey = opts.apiKey ?? loadOrCreateApiKey();
    const publicUrl = opts.publicUrl ?? loadPublicUrl() ?? null;

    // Detect whether this invocation is "dev mode" (started by a human shell)
    // or "prod mode" (started by launchd). PPID 1 = launchd on macOS.
    const isProdInvocation = opts.prod === true || process.ppid === 1;

    let resolvedPort = requestedPort;

    if (!isProdInvocation) {
      const {
        resolveDevPlan, detectProdActive, isPortInUse, findFreePortSync, takeoverProd,
      } = await import("../src/lifecycle/dev-takeover");
      const { interactivePrompt } = await import("../src/lifecycle/prompt");
      const { getGitToplevel } = await import("../src/lifecycle/repo");

      const repoToplevel = getGitToplevel(process.cwd());
      const portTaken = await isPortInUse(requestedPort);

      const plan = await resolveDevPlan({
        requestedPort,
        replaceProd: opts.replaceProd === true,
        forget: opts.forget === true,
        forgetAll: opts.forgetAll === true,
        repoToplevel,
        isProdActive: detectProdActive,
        portInUse: () => portTaken,
        prompt: interactivePrompt,
        findFreePort: findFreePortSync,
      });

      resolvedPort = plan.port;
      if (plan.kind === "replace-prod") {
        takeoverProd({ port: plan.port, repoToplevel });
      }
    }

    const server = new StreamerServer({
      port: resolvedPort,
      apiKey,
      localNoAuth: opts.localNoAuth,
      verbose: opts.verbose,
      browseRoot: opts.browseRoot,
      publicUrl: opts.publicUrl,
    });

    await server.listen(resolvedPort);

    log.info(`Threadbase Streamer v${__VERSION__}`, { version: __VERSION__, port: resolvedPort });
    log.info(`Listening on http://localhost:${resolvedPort}`, {
      url: `http://localhost:${resolvedPort}`,
    });
    log.info(`WebSocket at ws://localhost:${resolvedPort}/ws`, {
      wsUrl: `ws://localhost:${resolvedPort}/ws`,
    });
    log.info(`API key: ${apiKey}`, { apiKeyMasked: `${apiKey.slice(0, 6)}…` });

    if (opts.pairQr !== false) {
      try {
        await printPairQR({ port: resolvedPort, apiKey, publicUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`(skipped pairing QR: ${message})`, { reason: message });
      }
    }

    const shutdown = async () => {
      log.info("Shutting down...");
      await server.close();
      process.exit(0);
    };

    if (isProdInvocation) {
      // Prod mode: simple shutdown handlers (no takeover semantics).
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
    // Dev mode with takeover already installed its handlers in takeoverProd().
    // Dev mode without takeover (use-port path) — install simple ones too:
    if (!isProdInvocation) {
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
  });
```

- [ ] **Step 3: Verify the file type-checks**

Run: `npm run lint 2>&1 | tail -30`
Expected: No new TS errors in `cli/index.ts`.

- [ ] **Step 4: Commit**

```bash
git add cli/index.ts
git commit -m "feat(lifecycle): wire --replace-prod, --forget, --forget-all flags into serve"
```

---

### Task 10: `prod` subcommand tree

**Files:**
- Create: `cli/prod.ts`
- Modify: `cli/index.ts` (register the subcommand)
- Test: `__tests__/lifecycle/prod-commands.test.ts`

Commands:
- `prod start` — clear marker if present, `launchctl kickstart -k`. Errors if agent not loaded ("run scripts/deploy.sh setup first").
- `prod stop` — `launchctl bootout`. Warns the supervised instance won't auto-restart until `prod start`.
- `prod status` — prints `{agentLoaded, agentPid, port, version, marker}`.
- `prod restart` — bootout + bootstrap (re-reads plist).
- `prod doctor` — detect stale marker (devPid dead but userHeld=false → fix by clearing), detect plist drift (installed plist doesn't contain the shim path → suggest re-running `scripts/deploy.sh setup`), detect zombie state (agent unloaded but no marker → recommend `prod start`).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/prod-commands.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runProdStart, runProdStop, runProdStatus, runProdDoctor,
} from "../../cli/prod";
import { writeMarker } from "../../src/lifecycle/marker";

vi.mock("../../src/lifecycle/launchd", () => ({
  isAgentLoaded: vi.fn(() => true),
  bootoutAgent: vi.fn(),
  bootstrapAgent: vi.fn(),
  kickstartAgent: vi.fn(),
  getAgentPid: vi.fn(() => 12345),
}));

import * as launchd from "../../src/lifecycle/launchd";

describe("prod commands", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prod-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
    vi.clearAllMocks();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("prod start: errors when agent not loaded", async () => {
    vi.mocked(launchd.isAgentLoaded).mockReturnValue(false);
    const result = await runProdStart();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/scripts\/deploy\.sh setup/);
  });

  it("prod start: clears marker and kickstarts when agent loaded", async () => {
    vi.mocked(launchd.isAgentLoaded).mockReturnValue(true);
    writeMarker({
      devPid: 1, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: true, shimVersion: 1,
    });
    const result = await runProdStart();
    expect(result.ok).toBe(true);
    expect(launchd.kickstartAgent).toHaveBeenCalled();
    // Marker should be gone.
    const { readMarker } = await import("../../src/lifecycle/marker");
    expect(readMarker()).toBeNull();
  });

  it("prod stop: bootouts the agent", async () => {
    const result = await runProdStop();
    expect(result.ok).toBe(true);
    expect(launchd.bootoutAgent).toHaveBeenCalled();
  });

  it("prod status: returns running state", async () => {
    const status = await runProdStatus();
    expect(status.agentLoaded).toBe(true);
    expect(status.agentPid).toBe(12345);
    expect(status.marker).toBeNull();
  });

  it("prod status: reports marker when present", async () => {
    writeMarker({
      devPid: 1, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: true, shimVersion: 1,
    });
    const status = await runProdStatus();
    expect(status.marker?.userHeld).toBe(true);
  });

  it("prod doctor: detects + repairs stale marker (dead PID, not userHeld)", async () => {
    writeMarker({
      devPid: 999999, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 1,
    });
    const report = await runProdDoctor({ fix: true });
    expect(report.repairs).toContain("cleared stale marker (dev pid 999999 was dead)");
    const { readMarker } = await import("../../src/lifecycle/marker");
    expect(readMarker()).toBeNull();
  });

  it("prod doctor: reports without fixing when fix=false", async () => {
    writeMarker({
      devPid: 999999, port: 8766, repoToplevel: "/x",
      suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 1,
    });
    const report = await runProdDoctor({ fix: false });
    expect(report.findings).toContain("stale marker (dev pid 999999 dead)");
    const { readMarker } = await import("../../src/lifecycle/marker");
    expect(readMarker()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/prod-commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cli/prod.ts`**

```typescript
// cli/prod.ts
import { Command } from "commander";
import {
  bootoutAgent, getAgentPid, isAgentLoaded, kickstartAgent,
} from "../src/lifecycle/launchd";
import { clearMarker, readMarker } from "../src/lifecycle/marker";
import { isPidAlive } from "../src/lifecycle/process-liveness";
import { getLogger } from "../src/logger";

const log = getLogger("prod");

export type CommandResult = { ok: boolean; message: string };

export async function runProdStart(): Promise<CommandResult> {
  if (!isAgentLoaded()) {
    return {
      ok: false,
      message:
        "launchd agent com.ronen.threadbase is not loaded. " +
        "Run 'scripts/deploy.sh setup' to install it.",
    };
  }
  clearMarker();
  kickstartAgent();
  return { ok: true, message: "prod streamer restored — launchd is starting it now." };
}

export async function runProdStop(): Promise<CommandResult> {
  bootoutAgent();
  return {
    ok: true,
    message:
      "prod streamer stopped (launchd agent unloaded). " +
      "It will not auto-restart until 'tb-streamer prod start' or system reboot.",
  };
}

export type ProdStatus = {
  agentLoaded: boolean;
  agentPid: number | null;
  marker: ReturnType<typeof readMarker>;
};

export async function runProdStatus(): Promise<ProdStatus> {
  return {
    agentLoaded: isAgentLoaded(),
    agentPid: getAgentPid(),
    marker: readMarker(),
  };
}

export type DoctorReport = { findings: string[]; repairs: string[] };

export async function runProdDoctor(opts: { fix: boolean }): Promise<DoctorReport> {
  const findings: string[] = [];
  const repairs: string[] = [];

  const marker = readMarker();
  if (marker && !marker.userHeld && !isPidAlive(marker.devPid)) {
    findings.push(`stale marker (dev pid ${marker.devPid} dead)`);
    if (opts.fix) {
      clearMarker();
      repairs.push(`cleared stale marker (dev pid ${marker.devPid} was dead)`);
    }
  }

  if (!isAgentLoaded()) {
    findings.push("launchd agent is not loaded — prod is fully down");
  }

  return { findings, repairs };
}

export function registerProdCommands(program: Command): void {
  const prod = new Command("prod").description("Manage the launchd-supervised prod streamer");

  prod
    .command("start")
    .description("Restore prod after a user-held suspension")
    .action(async () => {
      const r = await runProdStart();
      log.info(r.message, undefined, "console");
      if (!r.ok) process.exitCode = 1;
    });

  prod
    .command("stop")
    .description("Unload the launchd agent (prod will not auto-restart)")
    .action(async () => {
      const r = await runProdStop();
      log.info(r.message, undefined, "console");
    });

  prod
    .command("status")
    .description("Report whether prod is supervised, suspended, or down")
    .action(async () => {
      const s = await runProdStatus();
      const parts = [
        `agent: ${s.agentLoaded ? "loaded" : "NOT loaded"}`,
        `pid: ${s.agentPid ?? "(none)"}`,
        s.marker
          ? `marker: ${s.marker.userHeld ? "userHeld (intentional stop)" : "dev-suspended"}, ` +
            `devPid=${s.marker.devPid}, port=${s.marker.port}, repo=${s.marker.repoToplevel}`
          : "marker: none",
      ];
      log.info(parts.join("\n  "), undefined, "console");
    });

  prod
    .command("restart")
    .description("Bootout + bootstrap the launchd agent (re-read plist)")
    .action(async () => {
      bootoutAgent();
      const { bootstrapAgent } = await import("../src/lifecycle/launchd");
      const plist = `${process.env.HOME}/Library/LaunchAgents/com.ronen.threadbase.plist`;
      bootstrapAgent(plist);
      log.info(`agent restarted from ${plist}`, undefined, "console");
    });

  prod
    .command("doctor")
    .description("Detect & repair stale markers, missing agent, plist drift")
    .option("--fix", "Apply repairs (default is dry-run)", false)
    .action(async (opts) => {
      const r = await runProdDoctor({ fix: opts.fix === true });
      log.info(`findings: ${r.findings.length === 0 ? "(none)" : ""}`, undefined, "console");
      for (const f of r.findings) log.info(`  - ${f}`, undefined, "console");
      if (r.repairs.length) {
        log.info(`repairs:`, undefined, "console");
        for (const fix of r.repairs) log.info(`  - ${fix}`, undefined, "console");
      } else if (!opts.fix && r.findings.length > 0) {
        log.info(`(re-run with --fix to apply repairs)`, undefined, "console");
      }
    });

  program.addCommand(prod);
}
```

- [ ] **Step 4: Register in `cli/index.ts`**

Add this **before** `program.parse();`:

```typescript
import { registerProdCommands } from "./prod";
registerProdCommands(program);
```

- [ ] **Step 5: Run tests to verify passing**

Run: `npx vitest run __tests__/lifecycle/prod-commands.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add cli/prod.ts cli/index.ts __tests__/lifecycle/prod-commands.test.ts
git commit -m "feat(lifecycle): add 'prod' subcommand tree (start/stop/status/restart/doctor)"
```

---

### Task 11: Update `scripts/deploy.sh` plist generator

**Files:**
- Modify: `scripts/deploy.sh` (`write_plist` and `ensure_plist_healthy`)

The plist needs three changes:
1. `ProgramArguments` points at `launchd-entry.cjs` instead of `cli.js` (the shim then `exec`s `cli.js`).
2. `KeepAlive` becomes a dict with `SuccessfulExit: false` so a clean shim exit (userHeld / dev-alive) does **not** trigger respawn.
3. Add `ThrottleInterval: 10` to limit fast crash loops.

`ensure_plist_healthy` gets a new self-heal rule that detects the old layout and rewrites it.

- [ ] **Step 1: Update `write_plist()`**

Find `write_plist()` at line 360. Replace its body (the `cat > "$plist_path" <<PLIST … PLIST` heredoc) with:

```bash
write_plist() {
  local plist_path="$1" node_bin="$2" run_at_load="$3"
  local logs_dir="$INSTALL_DIR/logs"
  local shim_path="$INSTALL_DIR/launchd-entry.cjs"
  local node_bin_dir
  node_bin_dir="$(dirname "$node_bin")"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$shim_path</string>
    <string>serve</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--verbose</string>
    <string>--prod</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$node_bin_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <$run_at_load/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$logs_dir/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$logs_dir/stderr.log</string>
</dict>
</plist>
PLIST
}
```

Three concrete changes:
- `<string>$ACTIVE_LINK</string>` → `<string>$shim_path</string>` (and `$shim_path` is `$INSTALL_DIR/launchd-entry.cjs`).
- Added `<string>--prod</string>` to argv (so the shim's `exec`'d `cli.js` recognises this as a launchd invocation and skips dev-takeover wiring even if `process.ppid !== 1` for some reason).
- `<key>KeepAlive</key><$run_at_load/>` (bare bool) → `<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>` (dict form).
- Added `<key>ThrottleInterval</key><integer>10</integer>`.

- [ ] **Step 2: Extend `ensure_plist_healthy()` with a shim-path check**

Find `ensure_plist_healthy()` at line 434. After the existing `EnvironmentVariables` check, add another self-heal rule. Replace the function with:

```bash
ensure_plist_healthy() {
  local plist_path="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  [[ -f "$plist_path" ]] || return 0

  local needs_rewrite="false"

  if ! grep -q "EnvironmentVariables" "$plist_path"; then
    warn "plist is missing EnvironmentVariables block — claude won't be on launchd's PATH"
    needs_rewrite="true"
  fi

  # New: detect old layout that points at cli.js directly (no shim).
  if grep -q "<string>$ACTIVE_LINK</string>" "$plist_path"; then
    warn "plist still points at cli.js directly (no shim) — rewriting to use launchd-entry.cjs"
    needs_rewrite="true"
  fi

  # New: detect bare-bool KeepAlive (pre-shim era).
  if awk '/<key>KeepAlive<\/key>/{getline; print}' "$plist_path" | grep -q "<true/>\|<false/>"; then
    warn "plist uses bare-bool KeepAlive — rewriting to dict form (SuccessfulExit=false)"
    needs_rewrite="true"
  fi

  [[ "$needs_rewrite" != "true" ]] && return 0

  warn "rewriting $plist_path and re-bootstrapping"
  local node_bin
  node_bin="$(command -v node)" || { err "node not found in PATH"; exit 1; }

  local run_at_load="true"
  if grep -q "<key>RunAtLoad</key>" "$plist_path" \
     && awk '/<key>RunAtLoad<\/key>/{getline; print}' "$plist_path" | grep -q "<false/>"; then
    run_at_load="false"
  fi

  cp "$plist_path" "$plist_path.bak.$(date +%s)" 2>/dev/null || true
  write_plist "$plist_path" "$node_bin" "$run_at_load"
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  ok "plist healed (backup at $plist_path.bak.*)"
}
```

- [ ] **Step 3: Ensure `cmd_deploy()` copies the shim into `$INSTALL_DIR`**

The deploy flow currently copies `dist/cli.cjs` into `$RELEASES_DIR/cli.<sha>.cjs` and symlinks. We also need `dist/launchd-entry.cjs` available at `$INSTALL_DIR/launchd-entry.cjs` (referenced by the plist).

Find `cmd_deploy()` (search for `cmd_deploy()` in deploy.sh). After the existing line that copies/stamps the release (search for `stamping release`), add:

```bash
  # Copy the launchd shim alongside the active cli.js. The plist always
  # references $INSTALL_DIR/launchd-entry.cjs (no per-release versioning —
  # the shim is small and only ever forwards to whatever cli.js the symlink
  # points at).
  log "installing launchd shim → $INSTALL_DIR/launchd-entry.cjs"
  cp "$REPO_ROOT/dist/launchd-entry.cjs" "$INSTALL_DIR/launchd-entry.cjs"
  chmod +x "$INSTALL_DIR/launchd-entry.cjs"
```

(Find a good anchor by searching for the existing `cp` of `cli.cjs` in `cmd_deploy()` and place the new lines immediately after it.)

- [ ] **Step 4: Test deploy.sh changes don't break the existing path**

This is hard to fully test without actually running the deploy. Do a dry sanity check:
- Run `bash -n scripts/deploy.sh` — expected: no syntax errors.
- Read through the diff manually to verify no other plist references need updating.

Run: `bash -n scripts/deploy.sh && echo "syntax ok"`
Expected: "syntax ok"

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat(lifecycle): plist generator emits shim path + KeepAlive dict form"
```

---

### Task 12: Integration test — full shim decision path against real marker file

**Files:**
- Create: `__tests__/lifecycle/integration.test.ts`

This test exercises the shim end-to-end (writing a marker, executing the shim binary, asserting on its exit code + stderr). It's slow (~1s per case) but proves the wired-up flow works.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/integration.test.ts
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO_ROOT = join(__dirname, "..", "..");
const SHIM = join(REPO_ROOT, "dist", "launchd-entry.cjs");

describe("launchd shim integration", () => {
  let dir: string;

  beforeAll(() => {
    // Ensure the shim is built.
    if (!existsSync(SHIM)) {
      execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
    }
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shim-int-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runShim(env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [SHIM, "serve", "--port", "65530", "--no-pair-qr"], {
      env: { ...process.env, THREADBASE_INSTALL_DIR: dir, ...env },
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("absent marker + missing cli.js → exits non-zero with 'active link missing'", () => {
    const result = runShim();
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/active link missing/);
  });

  it("userHeld marker → exits 0 without trying to start cli.js", () => {
    const fs = require("node:fs");
    fs.writeFileSync(
      join(dir, "prod-suspended.json"),
      JSON.stringify({
        devPid: 1, port: 8766, repoToplevel: "/x",
        suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: true, shimVersion: 1,
      }),
    );
    const result = runShim();
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toMatch(/user-held/);
  });

  it("stale marker (dead pid, not userHeld) → clears marker and tries to exec", () => {
    const fs = require("node:fs");
    fs.writeFileSync(
      join(dir, "prod-suspended.json"),
      JSON.stringify({
        devPid: 999999, port: 8766, repoToplevel: "/x",
        suspendedAt: "2026-05-30T19:55:00.000Z", userHeld: false, shimVersion: 1,
      }),
    );
    runShim();
    // Marker should be cleared regardless of cli.js outcome.
    expect(existsSync(join(dir, "prod-suspended.json"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it passes (no test failures expected — the implementation already exists from Task 7)**

Run: `npx vitest run __tests__/lifecycle/integration.test.ts`
Expected: PASS — 3 tests (slowest, may take ~5s).

- [ ] **Step 3: Commit**

```bash
git add __tests__/lifecycle/integration.test.ts
git commit -m "test(lifecycle): integration test for shim against real marker file"
```

---

### Task 13: Run the full test suite

- [ ] **Step 1: Run all tests**

Run: `npm test 2>&1 | tail -20`
Expected: All previously-passing tests still pass + new lifecycle tests pass. Total should be ~388 + ~26 new = ~414.

- [ ] **Step 2: Run lint**

Run: `npm run lint 2>&1 | tail -10`
Expected: 0 new TS errors and 0 new biome errors in the lifecycle files.

- [ ] **Step 3: If anything fails, fix and re-run before continuing.**

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(lifecycle): clean up post-suite fixes"
# (or skip if nothing to fix)
```

---

### Task 14: Manual end-to-end verification on a real Mac

This task does **not** modify code. It deploys the work and exercises every flow against real launchd. Done by the engineer manually.

- [ ] **Step 1: Build + deploy the new plist + shim**

Run:
```bash
cd ~/Desktop/dev/ai-tools/tb-streamer
npm run deploy -- --install-shim=skip --path-update=skip
```

The `ensure_plist_healthy` self-heal should detect the old plist (which still points at `cli.js` directly) and rewrite it. Verify the new plist contains:
- `<string>$HOME/.threadbase/launchd-entry.cjs</string>` in `ProgramArguments`.
- `<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>` (dict, not bare bool).
- `<key>ThrottleInterval</key><integer>10</integer>`.

```bash
cat ~/Library/LaunchAgents/com.ronen.threadbase.plist
```

- [ ] **Step 2: Verify prod is healthy**

```bash
tb-streamer prod status
# Expected: agent: loaded, pid: <some N>, marker: none

curl -fsS http://localhost:8766/healthz
# Expected: {"ok":true,"version":"1.0.1+<sha>"}
```

- [ ] **Step 3: Verify dev-mode prompt fires on conflict**

In a new terminal, in the tb-mobile repo:
```bash
cd ~/Desktop/dev/ai-tools/tb-mobile  # any git repo will do; this one's handy
tb-streamer serve --port 8766
# Expected: interactive prompt asking [r]eplace prod or [p]ort 8767
# Pick [p], then [N] (don't remember).
```

- [ ] **Step 4: Verify `--replace-prod`**

```bash
# Kill the dev from step 3 (Ctrl-C).
# Now:
tb-streamer serve --port 8766 --replace-prod
# Expected: no prompt, dev binds 8766 immediately.
# Verify: `tb-streamer prod status` (in another terminal) shows agent NOT loaded, marker shows userHeld=false + devPid=<the dev pid>.
```

- [ ] **Step 5: Verify clean exit → userHeld=true**

```bash
# Ctrl-C the dev from step 4.
# Then:
tb-streamer prod status
# Expected: marker shows userHeld=true.
# Verify launchd is NOT respawning:
launchctl print gui/$UID/com.ronen.threadbase 2>&1 | head -5
# Should show "Could not find service" or similar (agent is unloaded).
```

- [ ] **Step 6: Verify `tb-streamer prod start` restores**

```bash
tb-streamer prod start
# Expected: "prod streamer restored — launchd is starting it now."
sleep 2
tb-streamer prod status
# Expected: agent loaded, marker: none.
curl -fsS http://localhost:8766/healthz
# Expected: 200 OK.
```

- [ ] **Step 7: Verify crash recovery**

```bash
tb-streamer serve --port 8766 --replace-prod &
DEV_PID=$!
sleep 2
tb-streamer prod status   # should show marker.userHeld=false, devPid=$DEV_PID
kill -9 $DEV_PID
sleep 2
# Wait for launchd to retry (ThrottleInterval=10s). The shim should detect
# the dead PID, delete the marker, and exec cli.js.
sleep 12
tb-streamer prod status
# Expected: agent loaded, marker: none.
```

- [ ] **Step 8: Verify remembered choice**

```bash
cd ~/Desktop/dev/ai-tools/tb-mobile
tb-streamer serve --port 8766
# Pick [p] for port, then [Y] to remember.
# Ctrl-C.
tb-streamer serve --port 8766
# Expected: no prompt, dev binds the alt port immediately.
# Verify:
cat ~/.threadbase/dev-prefs.json
```

- [ ] **Step 9: Verify `--forget`**

```bash
tb-streamer serve --port 8766 --forget
# Expected: prompt fires again. The pref for this repo is gone before the prompt.
```

- [ ] **Step 10: Verify `prod doctor`**

```bash
# Manually craft a stale marker (dev PID 999999 dead, userHeld=false):
echo '{"devPid":999999,"port":8766,"repoToplevel":"/x","suspendedAt":"2026-05-30T19:55:00.000Z","userHeld":false,"shimVersion":1}' > ~/.threadbase/prod-suspended.json
tb-streamer prod doctor
# Expected: findings list "stale marker (dev pid 999999 dead)" + "(re-run with --fix to apply repairs)"
tb-streamer prod doctor --fix
# Expected: repairs list "cleared stale marker (dev pid 999999 was dead)"
ls ~/.threadbase/prod-suspended.json
# Expected: no such file.
```

- [ ] **Step 11: Reproduce the original screenshot bug to confirm fix is live**

Open the mobile app, navigate to session `dbdc2206-c891-4d5e-9146-2100fdcd9b75`, scroll through the conversation. The terminal lines that previously appeared above the chat should now be in correct on-screen order (the May-29 headless-terminal fix is in the running binary because the shim execs into `cli.js` which is now the `882d4df` build).

- [ ] **Step 12: Commit any final docs / verification notes**

```bash
# If you wrote notes:
git add docs/superpowers/
git commit -m "docs(lifecycle): manual verification notes"
```

---

### Task 15: PR + merge

- [ ] **Step 1: Push the branch**

```bash
git push -u origin <your-branch-name>
```

- [ ] **Step 2: Open a PR**

Title: `feat(lifecycle): single-instance prod streamer with dev-takeover coordination`

Body should reference this plan path and link the session screenshot if useful.

- [ ] **Step 3: After merge, re-deploy on this Mac**

```bash
cd ~/Desktop/dev/ai-tools/tb-streamer
git checkout main && git pull
npm run deploy
```

---

## Self-Review

Spec coverage:
- ✅ Single launchd-supervised prod instance — `KeepAlive.SuccessfulExit=false` plus shim (Task 7, 11)
- ✅ Dev prompt on port conflict — `interactivePrompt` + `resolveDevPlan` (Task 8)
- ✅ Remember-the-selection (per-repo) — `prefs.ts` (Task 5)
- ✅ `--replace-prod` flag — Task 8 + Task 9
- ✅ `--port <n>` for dev — already exists in commander, no change needed; takeover never fires when there's no conflict (Task 8)
- ✅ `--forget` and `--forget-all` — Task 5 + Task 8 + Task 9
- ✅ Clean exit = user-held; crash = auto-restore — `takeoverProd` signal handlers (Task 8) + shim crash-recovery branch (Task 7)
- ✅ `tb-streamer prod start | stop | status | restart | doctor` — Task 10
- ✅ launchd retries bounded — `KeepAlive.SuccessfulExit=false` (Task 11) + `ThrottleInterval=10` for crash loops
- ✅ Handles SIGINT, SIGTERM, SIGHUP, uncaughtException — Task 8 signal handlers
- ✅ Shim is in plist (Option A) — Task 7 + 11

Placeholder scan: none.

Type consistency: `Marker`, `Prefs`, `RepoChoice`, `DevPlan`, `PromptResult`, `CommandResult`, `ProdStatus`, `DoctorReport`, `ShimAction` — all defined once, referenced consistently.

Known gaps consciously deferred (out of scope for this plan; track separately):
- `/healthz` exposing `gitSha` — already present (`/healthz` returns `{ok:true, version:"...+<sha>"}` per the deploy output earlier). No change needed.
- PID-reuse defense (checking exe path, not just PID) — left as TODO in `process-liveness.ts`. The current `isPidAlive` is sufficient for the documented threat model; the more paranoid check can ship later if a real false-positive is observed.
- Log rotation for `~/Library/Logs/threadbase/*.log` — separate ops concern.
