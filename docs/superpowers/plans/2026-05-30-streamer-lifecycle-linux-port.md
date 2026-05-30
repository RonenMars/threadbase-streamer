# Streamer Lifecycle: Linux Port (systemd --user) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the lifecycle module (currently macOS + Windows) to Linux, so `tb-streamer serve --replace-prod / --forget`, the dev-takeover prompt, and the `tb-streamer prod start|stop|status|restart|doctor` subcommands work on Linux deployments. Today `getSupervisor()` throws on Linux.

**Architecture:** Third `Supervisor` backend (`src/lifecycle/systemd.ts`) wrapping `systemctl --user` cmdlets. The systemd `Restart=on-failure` semantics map cleanly to launchd's `KeepAlive: SuccessfulExit=false` — both let the shim exit 0 to suppress respawn. The existing launchd shim is reused on Linux (its decision logic is platform-agnostic; the platform guard is widened to allow `linux`). `scripts/deploy-linux.sh` is updated to point the systemd unit at the shim and pass `--prod`.

**Tech Stack:** TypeScript / Vitest with `vi.mock` / Node `child_process.execFileSync` → `systemctl --user` / systemd user services on Linux 22.04+ (or any distro shipping systemd 245+).

---

## Scope check

One cohesive subsystem. Produces working, testable software on its own: after Task 7 every `tb-streamer prod` command works on Linux and dev-takeover prompts fire correctly.

Out of scope:
- BSD or other init systems (sysvinit, OpenRC, runit). Not in active use for this project.
- Linux distros without `systemd --user` support (e.g. Alpine before 3.18). Document as unsupported.
- Reusing the existing macOS shim build pipeline for Linux ELF — `dist/launchd-entry.cjs` is a JS file run via Node, so it's portable across platforms with no rebuild needed.

---

## File Structure

**New files:**
- `src/lifecycle/systemd.ts` — Linux equivalent of `task-scheduler.ts`. Same 5 exported functions, same signatures, different implementation (`systemctl --user` cmdlets). ~70 lines.
- `__tests__/lifecycle/systemd.test.ts` — mirrors `task-scheduler.test.ts`. Uses `vi.mock("node:child_process")`. ~90 lines.

**Modified files:**
- `src/lifecycle/platform.ts` — add `linux` branch returning the systemd backend. ~5 lines.
- `__tests__/lifecycle/platform.test.ts` — add `it.runIf(process.platform === "linux")("picks systemd on linux", ...)` test. ~10 lines.
- `cli/launchd-entry.ts` — widen the platform guard from `process.platform !== "darwin"` to `process.platform !== "darwin" && process.platform !== "linux"`. The decision logic itself (marker / userHeld / devPid / crash-recovery) is platform-agnostic.
- `__tests__/lifecycle/launchd-entry.test.ts` — update the existing platform-mismatch test so it tries `aix` or some other unsupported platform instead of `win32` (since win32 is still mismatch but linux is now passing). Add a new test: shim runs on linux when marker absent.
- `cli/prod.ts` — extend the platform-conditional `runProdStart` and `runProdStop` error messages with a Linux branch ("systemd unit 'threadbase.service' is not enabled. Run 'scripts/deploy-linux.sh setup'"). Extend the `prod restart` action to handle Linux (the `specPath` argument can be ignored — systemd re-reads the unit on `daemon-reload`).
- `__tests__/lifecycle/prod-commands.test.ts` — the existing regex `/(scripts\/deploy\.sh|scripts\\deploy\.ps1)/` needs a third alternative for the Linux message.
- `src/lifecycle/constants.ts` — add `SYSTEMD_UNIT = process.env.THREADBASE_SYSTEMD_UNIT ?? "threadbase.service"`. Already established by the rest of the codebase (`docs/auto-update.md` table; `src/updater/restart.ts` uses the env var).
- `scripts/deploy-linux.sh` — update the systemd unit's `ExecStart` to invoke the shim with `--prod`; add an `ensure_unit_healthy` self-heal mirroring `ensure_plist_healthy` from `deploy.sh`. Copy `dist/launchd-entry.cjs` into `$INSTALL_DIR/launchd-entry.cjs` like the macOS deploy does.
- `CLAUDE.md` — add a "### Linux (systemd --user)" subsection to the "Prod/dev coordination" section.
- `docs/troubleshooting.md` — add Linux entries to "Prod/dev coordination" (3 entries).

**Files unchanged (worth noting):**
- `src/lifecycle/marker.ts`, `marker-schema.ts`, `prefs.ts`, `process-liveness.ts`, `repo.ts`, `prompt.ts`, `dev-takeover.ts` — all portable. `process.kill(pid, 0)` works on Linux (and is the natural POSIX form). `os.homedir()` returns the right path. `findFreePort` uses `net.createServer` (portable since the Windows port).
- `cli/prod.ts` — already routes through `getSupervisor()`. No change needed beyond the error-message branches.

---

## Supervisor interface (reused from existing implementation)

Already defined in `src/lifecycle/platform.ts`:

```typescript
export interface Supervisor {
  isAgentLoaded(): boolean;
  bootoutAgent(): void;
  bootstrapAgent(specPath: string): void;
  kickstartAgent(): void;
  getAgentPid(): number | null;
}
```

On Linux, the mapping is:

| Method | systemd cmdlet |
|---|---|
| `isAgentLoaded()` | `systemctl --user list-unit-files <unit>` returns success |
| `bootoutAgent()` | `systemctl --user stop <unit>` + `systemctl --user disable <unit>` |
| `bootstrapAgent(specPath)` | `systemctl --user enable <unit>` + `systemctl --user start <unit>`. `specPath` is ignored. |
| `kickstartAgent()` | `systemctl --user restart <unit>` |
| `getAgentPid()` | `systemctl --user show -p MainPID --value <unit>` parses to an int |

---

## Constants

Existing in `src/lifecycle/constants.ts`:
- `LAUNCHD_LABEL`, `TASK_NAME`, `DEFAULT_PROD_PORT`, `installDir()`, `markerPath()`, `prefsPath()`, `activeLink()`

New (added in Task 1):
- `SYSTEMD_UNIT = process.env.THREADBASE_SYSTEMD_UNIT ?? "threadbase.service"`

---

## Tasks

> **Test discipline:** Each task is TDD — failing test first, run it to confirm it fails for the expected reason, implement minimal code, run it to confirm it passes, commit. Do not advance to the next step until the current one runs successfully.

> **Commit message format:** `<type>(lifecycle-linux): <description>`. Scope is `lifecycle-linux` to distinguish from the macOS (`lifecycle`) and Windows (`lifecycle-win`) work.

> **One commit per task** unless a task explicitly splits commits.

> **Cross-platform CI:** Vitest is run on macOS (your dev machine) and may run on Linux/Windows CI. Tests that mock `child_process` work on every platform. Tests that hit real `systemctl` only run on Linux — gate with `it.runIf(process.platform === "linux")` or `vi.mock`.

---

### Task 1: Add `SYSTEMD_UNIT` constant

**Files:**
- Modify: `src/lifecycle/constants.ts`
- Test: extend `__tests__/lifecycle/constants.test.ts`

The other Supervisor backends already use constants (`LAUNCHD_LABEL` for macOS, `TASK_NAME` for Windows). Add the matching one for Linux. The env var `THREADBASE_SYSTEMD_UNIT` is already documented in `docs/auto-update.md` and used by `src/updater/restart.ts`, so reuse the same name.

- [ ] **Step 1: Extend the failing test**

Append to `__tests__/lifecycle/constants.test.ts`:

```typescript
describe("SYSTEMD_UNIT", () => {
  it("defaults to 'threadbase.service' when env var unset", () => {
    delete process.env.THREADBASE_SYSTEMD_UNIT;
    // SYSTEMD_UNIT is evaluated at module load; force a fresh import
    const mod = require("../../src/lifecycle/constants");
    expect(mod.SYSTEMD_UNIT).toBe("threadbase.service");
  });
});
```

Note: `LAUNCHD_LABEL` and `TASK_NAME` are evaluated at module load too. The existing tests work because they don't reload the module. For `SYSTEMD_UNIT` the simplest assertion is to just check the constant exists with the expected default. Drop the dynamic-reload approach — just import it normally:

```typescript
import { SYSTEMD_UNIT } from "../../src/lifecycle/constants";

describe("SYSTEMD_UNIT", () => {
  it("is 'threadbase.service' by default", () => {
    expect(SYSTEMD_UNIT).toBe("threadbase.service");
  });
});
```

(The env-var-override path is intentionally untested at the unit level because it's set at process start and validated by the integration setup in `scripts/deploy-linux.sh`. Same level of testing as `TASK_NAME`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/lifecycle/constants.test.ts`
Expected: FAIL — `SYSTEMD_UNIT` is not exported.

- [ ] **Step 3: Update `src/lifecycle/constants.ts`**

Find the existing line:
```typescript
export const TASK_NAME = process.env.THREADBASE_TASK_NAME ?? "Threadbase";
```

Immediately after it, add:
```typescript
export const SYSTEMD_UNIT = process.env.THREADBASE_SYSTEMD_UNIT ?? "threadbase.service";
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run __tests__/lifecycle/constants.test.ts`
Expected: PASS — all constants tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/constants.ts __tests__/lifecycle/constants.test.ts
git commit -m "feat(lifecycle-linux): add SYSTEMD_UNIT constant"
```

---

### Task 2: Implement the systemd backend

**Files:**
- Create: `src/lifecycle/systemd.ts`
- Test: `__tests__/lifecycle/systemd.test.ts`

Mirror the shape of `task-scheduler.ts`. Mock `child_process.execFileSync` in tests so we don't need a real systemd.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/systemd.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  bootoutAgent,
  bootstrapAgent,
  getAgentPid,
  isAgentLoaded,
  kickstartAgent,
} from "../../src/lifecycle/systemd";

describe("systemd wrappers", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("isAgentLoaded calls systemctl --user list-unit-files threadbase.service", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    expect(isAgentLoaded()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "list-unit-files", "threadbase.service"],
      expect.any(Object),
    );
  });

  it("isAgentLoaded returns false when systemctl throws", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Unit threadbase.service not found.");
    });
    expect(isAgentLoaded()).toBe(false);
  });

  it("bootoutAgent runs stop + disable, swallows errors", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("nope");
    });
    expect(() => bootoutAgent()).not.toThrow();
  });

  it("bootstrapAgent runs enable + start", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    bootstrapAgent("");
    const cmds = vi.mocked(execFileSync).mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(cmds.some((c) => /enable threadbase\.service/.test(c))).toBe(true);
    expect(cmds.some((c) => /start threadbase\.service/.test(c))).toBe(true);
  });

  it("kickstartAgent runs systemctl --user restart", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    kickstartAgent();
    expect(execFileSync).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "restart", "threadbase.service"],
      expect.any(Object),
    );
  });

  it("getAgentPid parses the PID from systemctl show output", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("12345\n"));
    expect(getAgentPid()).toBe(12345);
  });

  it("getAgentPid returns null when MainPID is 0 (unit stopped)", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("0\n"));
    expect(getAgentPid()).toBeNull();
  });

  it("getAgentPid returns null when systemctl errors", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not loaded");
    });
    expect(getAgentPid()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/systemd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lifecycle/systemd.ts`**

```typescript
// src/lifecycle/systemd.ts
import { execFileSync } from "node:child_process";
import { SYSTEMD_UNIT } from "./constants";

/**
 * Linux backend for the Supervisor interface. Wraps systemctl --user cmdlets.
 * Counterpart of launchd.ts (macOS) and task-scheduler.ts (Windows).
 *
 * systemd's Restart=on-failure semantics map cleanly to launchd's
 * KeepAlive: SuccessfulExit=false — both suppress respawn on a clean exit 0,
 * which is what the shim relies on for the dev-takeover handoff.
 */
function sc(args: string[]): string {
  return execFileSync("systemctl", ["--user", ...args], {
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
}

function scSafe(args: string[]): void {
  try {
    sc(args);
  } catch {
    // Intentionally swallowed — caller is one of the stop/disable variants where
    // "already gone" is the desired state.
  }
}

export function isAgentLoaded(): boolean {
  try {
    sc(["list-unit-files", SYSTEMD_UNIT]);
    return true;
  } catch {
    return false;
  }
}

export function bootoutAgent(): void {
  scSafe(["stop", SYSTEMD_UNIT]);
  scSafe(["disable", SYSTEMD_UNIT]);
}

export function bootstrapAgent(_specPath: string): void {
  // _specPath is the plist path on macOS; ignored on Linux because the unit
  // file is already at ~/.config/systemd/user/<unit>. The caller is asking us
  // to re-enable + start it. daemon-reload first picks up any unit file edits.
  scSafe(["daemon-reload"]);
  sc(["enable", SYSTEMD_UNIT]);
  sc(["start", SYSTEMD_UNIT]);
}

export function kickstartAgent(): void {
  sc(["restart", SYSTEMD_UNIT]);
}

export function getAgentPid(): number | null {
  try {
    const out = sc(["show", "-p", "MainPID", "--value", SYSTEMD_UNIT]).trim();
    const n = Number.parseInt(out, 10);
    // systemctl returns MainPID=0 when the unit is loaded but stopped.
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/lifecycle/systemd.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/systemd.ts __tests__/lifecycle/systemd.test.ts
git commit -m "feat(lifecycle-linux): implement systemd --user backend"
```

---

### Task 3: Wire `getSupervisor()` to dispatch to the systemd backend

**Files:**
- Modify: `src/lifecycle/platform.ts`
- Test: extend `__tests__/lifecycle/platform.test.ts`

- [ ] **Step 1: Extend the failing test**

The existing test file has `it.runIf(process.platform === "linux")("...", () => { expect(() => getSupervisor()).toThrow(/unsupported/i); })` (or similar — read the file first to confirm).

Change it to:
```typescript
it.runIf(process.platform === "linux")("picks systemd on linux", async () => {
  const sup = getSupervisor();
  const systemd = await import("../../src/lifecycle/systemd");
  expect(sup.isAgentLoaded).toBe(systemd.isAgentLoaded);
});
```

And remove the "throws on unsupported platforms" test (since linux is now supported). Actually — keep that test but change the platform check: only `process.platform !== "darwin" && process.platform !== "win32" && process.platform !== "linux"` should throw. That's essentially the BSDs and esoteric platforms. Most CI won't hit that branch. Update:

```typescript
it.runIf(
  process.platform !== "darwin" &&
    process.platform !== "win32" &&
    process.platform !== "linux",
)("throws on unsupported platforms", () => {
  expect(() => getSupervisor()).toThrow(/unsupported/i);
});
```

- [ ] **Step 2: Run to verify the linux test fails on linux**

Run: `npx vitest run __tests__/lifecycle/platform.test.ts`

On macOS dev machine: the linux test is skipped (so the test suite stays green). On Linux CI: the linux test FAILS because `getSupervisor()` currently throws on Linux.

If you don't have Linux CI yet, the macOS test run will look passing — but the implementation change in Step 3 is still required for correctness. The test serves as a regression guard once Linux CI exists.

- [ ] **Step 3: Update `src/lifecycle/platform.ts`**

Current code (verify by reading):
```typescript
import * as launchd from "./launchd";
import * as taskScheduler from "./task-scheduler";

// ...

export function getSupervisor(): Supervisor {
  if (process.platform === "darwin") {
    return launchd;
  }
  if (process.platform === "win32") {
    return taskScheduler;
  }
  throw new Error(
    `lifecycle: unsupported platform ${process.platform}. Supported: darwin, win32.`,
  );
}
```

Add the systemd import and the linux branch:
```typescript
import * as launchd from "./launchd";
import * as systemd from "./systemd";
import * as taskScheduler from "./task-scheduler";

// ...

export function getSupervisor(): Supervisor {
  if (process.platform === "darwin") {
    return launchd;
  }
  if (process.platform === "win32") {
    return taskScheduler;
  }
  if (process.platform === "linux") {
    return systemd;
  }
  throw new Error(
    `lifecycle: unsupported platform ${process.platform}. Supported: darwin, win32, linux.`,
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/lifecycle/platform.test.ts`
Expected on macOS: 2 run (interface check + darwin), 2 skipped (win32 + linux + unsupported — well, 3 skipped).

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/platform.ts __tests__/lifecycle/platform.test.ts
git commit -m "feat(lifecycle-linux): wire getSupervisor() to systemd backend"
```

---

### Task 4: Allow the shim to run on Linux

**Files:**
- Modify: `cli/launchd-entry.ts`
- Test: extend `__tests__/lifecycle/launchd-entry.test.ts`

The shim's decision logic (marker → exec / exit / crash-recovery) is platform-agnostic. The platform guard was added in Win-7 to prevent the shim from accidentally running on Windows (where Task Scheduler invokes `cli.js` directly). On Linux, the systemd unit can and should invoke the shim, so the guard needs to allow Linux through.

- [ ] **Step 1: Extend the failing test**

The existing test has:
```typescript
describe("decideShimAction on non-darwin", () => {
  // ... existing afterEach restoring process.platform ...

  it("returns exit (with platform-mismatch reason) on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const action = decideShimAction();
    expect(action).toEqual({ kind: "exit", reason: "platform-mismatch" });
  });
});
```

Keep the existing win32 test (it's still correct — Windows is platform-mismatch). Add a new test that asserts linux is **NOT** mismatch:

```typescript
  it("returns exec on linux (when marker absent)", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const action = decideShimAction();
    expect(action).toEqual({ kind: "exec" });
  });
```

This new test requires a clean `THREADBASE_INSTALL_DIR` so the marker is absent. The existing `beforeEach` in the file should already set up a tmpdir for `THREADBASE_INSTALL_DIR` — verify by reading the test file. If the new `describe` block is outside that beforeEach scope, hoist it inside or duplicate the setup.

- [ ] **Step 2: Run to verify the linux test fails**

Run: `npx vitest run __tests__/lifecycle/launchd-entry.test.ts`
Expected: FAIL — the current guard returns `{ kind: "exit", reason: "platform-mismatch" }` on linux too.

- [ ] **Step 3: Update `cli/launchd-entry.ts`**

Find the guard at the top of `decideShimAction`:
```typescript
export function decideShimAction(): ShimAction {
  if (process.platform !== "darwin") {
    return { kind: "exit", reason: "platform-mismatch" };
  }
  // ... rest unchanged
```

Change to:
```typescript
export function decideShimAction(): ShimAction {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { kind: "exit", reason: "platform-mismatch" };
  }
  // ... rest unchanged
```

Update the `main()` log line for platform-mismatch to mention Linux:
```typescript
    if (action.reason === "platform-mismatch") {
      log.warn(
        `shim only runs on macOS (launchd) or Linux (systemd). ` +
          `Current platform: ${process.platform}. ` +
          `On Windows, Task Scheduler runs cli.js directly. Exiting.`,
      );
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/lifecycle/launchd-entry.test.ts`
Expected: PASS — 6 tests (the 5 existing + new linux test).

Verify the integration test still passes on darwin:
Run: `npx vitest run __tests__/lifecycle/integration.test.ts`
Expected: PASS — 3/3. Darwin behaviour unchanged.

- [ ] **Step 5: Commit**

```bash
git add cli/launchd-entry.ts __tests__/lifecycle/launchd-entry.test.ts
git commit -m "feat(lifecycle-linux): allow shim to run on Linux (systemd --user)"
```

---

### Task 5: Extend platform-aware messages in `cli/prod.ts`

**Files:**
- Modify: `cli/prod.ts`
- Modify: `__tests__/lifecycle/prod-commands.test.ts`

The existing `runProdStart` and `runProdStop` switch on `process.platform === "darwin"` (else assumed Windows). Linux now needs its own branch.

- [ ] **Step 1: Update `runProdStart`**

Current (read to confirm):
```typescript
export async function runProdStart(): Promise<CommandResult> {
  if (!getSupervisor().isAgentLoaded()) {
    const message =
      process.platform === "darwin"
        ? "launchd agent com.ronen.threadbase is not loaded. Run 'scripts/deploy.sh setup' to install it."
        : `task '${TASK_NAME}' is not registered. Run 'scripts\\deploy.ps1 setup' to install it.`;
    return { ok: false, message };
  }
  clearMarker();
  getSupervisor().kickstartAgent();
  const restoredMsg =
    process.platform === "darwin"
      ? "prod streamer restored — launchd is starting it now."
      : "prod streamer restored — Task Scheduler is starting it now.";
  return { ok: true, message: restoredMsg };
}
```

Refactor to switch on three platforms. Cleaner with a helper:
```typescript
function notLoadedMessage(): string {
  if (process.platform === "darwin") {
    return "launchd agent com.ronen.threadbase is not loaded. Run 'scripts/deploy.sh setup' to install it.";
  }
  if (process.platform === "linux") {
    return `systemd unit '${SYSTEMD_UNIT}' is not enabled. Run 'scripts/deploy-linux.sh setup' to install it.`;
  }
  return `task '${TASK_NAME}' is not registered. Run 'scripts\\deploy.ps1 setup' to install it.`;
}

function restoredMessage(): string {
  if (process.platform === "darwin") return "prod streamer restored — launchd is starting it now.";
  if (process.platform === "linux") return "prod streamer restored — systemd is starting it now.";
  return "prod streamer restored — Task Scheduler is starting it now.";
}
```

And update `runProdStart` to call them:
```typescript
export async function runProdStart(): Promise<CommandResult> {
  if (!getSupervisor().isAgentLoaded()) {
    return { ok: false, message: notLoadedMessage() };
  }
  clearMarker();
  getSupervisor().kickstartAgent();
  return { ok: true, message: restoredMessage() };
}
```

Add `SYSTEMD_UNIT` to the imports from `../src/lifecycle/constants`:
```typescript
import { SYSTEMD_UNIT, TASK_NAME } from "../src/lifecycle/constants";
```

- [ ] **Step 2: Update `runProdStop`**

Current:
```typescript
export async function runProdStop(): Promise<CommandResult> {
  getSupervisor().bootoutAgent();
  const what =
    process.platform === "darwin" ? "launchd agent unloaded" : "Task Scheduler task disabled";
  return {
    ok: true,
    message: `prod streamer stopped (${what}). It will not auto-restart until 'tb-streamer prod start' or system reboot.`,
  };
}
```

Update the `what` to handle three platforms:
```typescript
  const what =
    process.platform === "darwin"
      ? "launchd agent unloaded"
      : process.platform === "linux"
        ? "systemd unit stopped + disabled"
        : "Task Scheduler task disabled";
```

- [ ] **Step 3: Update the `prod restart` action**

Find the `prod restart` subcommand handler (inside `registerProdCommands`):

Current:
```typescript
  prod
    .command("restart")
    // ...
    .action(async () => {
      const sup = getSupervisor();
      sup.bootoutAgent();
      const specPath =
        process.platform === "darwin"
          ? `${process.env.HOME}/Library/LaunchAgents/com.ronen.threadbase.plist`
          : "";
      sup.bootstrapAgent(specPath);
      const what =
        process.platform === "darwin"
          ? `agent restarted from ${specPath}`
          : `task '${TASK_NAME}' restarted`;
      log.info(what, undefined, "console");
    });
```

Extend the `what` to handle Linux:
```typescript
      const what =
        process.platform === "darwin"
          ? `agent restarted from ${specPath}`
          : process.platform === "linux"
            ? `systemd unit '${SYSTEMD_UNIT}' restarted`
            : `task '${TASK_NAME}' restarted`;
```

(The `specPath` empty-string fallback for non-darwin already handles Linux correctly — both Windows and Linux ignore the argument in `bootstrapAgent`.)

- [ ] **Step 4: Update the test regex**

In `__tests__/lifecycle/prod-commands.test.ts`, find the test:
```typescript
it("prod start: errors when agent not loaded", async () => {
  mockSup.isAgentLoaded.mockReturnValue(false);
  const result = await runProdStart();
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/(scripts\/deploy\.sh|scripts\\deploy\.ps1)/);
});
```

Add the Linux alternative to the regex:
```typescript
  expect(result.message).toMatch(
    /(scripts\/deploy\.sh|scripts\\deploy\.ps1|scripts\/deploy-linux\.sh)/,
  );
```

Note: the macOS regex `scripts\/deploy\.sh` already accidentally matches `scripts\/deploy-linux\.sh` as a substring — the test would pass without changes. Add the explicit alternative anyway for clarity.

- [ ] **Step 5: Run tests**

Run: `npx vitest run __tests__/lifecycle/prod-commands.test.ts`
Expected: PASS — all 7 existing tests still pass with the updated regex.

- [ ] **Step 6: Commit**

```bash
git add cli/prod.ts __tests__/lifecycle/prod-commands.test.ts
git commit -m "feat(lifecycle-linux): platform-aware prod messages for systemd"
```

---

### Task 6: Update `scripts/deploy-linux.sh`

**Files:**
- Modify: `scripts/deploy-linux.sh`

Mirror what `scripts/deploy.sh` (macOS) does:
1. Point the unit's `ExecStart` at the shim (`$INSTALL_DIR/launchd-entry.cjs`) instead of `cli.js` directly.
2. Append `--prod` to the `serve` flags.
3. Copy `dist/launchd-entry.cjs` into `$INSTALL_DIR/launchd-entry.cjs` during deploy.
4. Add an `ensure_unit_healthy` self-heal that detects the old `ExecStart` shape and rewrites it.

- [ ] **Step 1: Locate the unit-write block**

Find the `cat > "$unit_file" <<UNIT ... UNIT` heredoc in `scripts/deploy-linux.sh`. The current content includes:

```bash
[Service]
ExecStart=$node_bin $ACTIVE_LINK serve --port $PORT --verbose
Restart=on-failure
```

- [ ] **Step 2: Update the unit-write block**

Add a `shim_path` local var earlier in the function:
```bash
  local shim_path="$INSTALL_DIR/launchd-entry.cjs"
```

Change the `ExecStart` line to:
```bash
ExecStart=$node_bin $shim_path serve --port $PORT --verbose --prod
```

Three concrete changes:
- `$ACTIVE_LINK` → `$shim_path`
- Added `--prod`
- `Restart=on-failure` is correct — leave unchanged. Together with the shim's exit-0 path, this gives launchd-equivalent "don't respawn on clean exit" semantics.

- [ ] **Step 3: Add a copy step in the deploy flow**

Find where `cmd_deploy()` (or the equivalent function — read the file to confirm) stamps a release and copies cli.cjs. After the cli copy, add:

```bash
  # Copy the launchd shim alongside cli.js. The unit always references
  # $INSTALL_DIR/launchd-entry.cjs (no per-release versioning).
  log "installing shim → $INSTALL_DIR/launchd-entry.cjs"
  cp "$REPO_ROOT/dist/launchd-entry.cjs" "$INSTALL_DIR/launchd-entry.cjs"
  chmod +x "$INSTALL_DIR/launchd-entry.cjs"
```

- [ ] **Step 4: Add `ensure_unit_healthy`**

Find a good anchor — typically right after the unit-write function. Add:

```bash
# Self-heal: existing units from before the lifecycle work point ExecStart at
# cli.js directly (no shim). Detect + rewrite in place.
ensure_unit_healthy() {
  local unit_file="$HOME/.config/systemd/user/$SYSTEMD_UNIT"
  [[ -f "$unit_file" ]] || return 0

  local needs_rewrite="false"

  if grep -q "ExecStart=.*$ACTIVE_LINK" "$unit_file"; then
    warn "unit still points at cli.js directly (no shim) — rewriting to use launchd-entry.cjs"
    needs_rewrite="true"
  fi

  if ! grep -q -- "--prod" "$unit_file"; then
    warn "unit is missing --prod flag — rewriting"
    needs_rewrite="true"
  fi

  [[ "$needs_rewrite" != "true" ]] && return 0

  warn "rewriting $unit_file"
  local node_bin
  node_bin="$(command -v node)" || { err "node not found in PATH"; exit 1; }

  cp "$unit_file" "$unit_file.bak.$(date +%s)" 2>/dev/null || true
  write_unit "$unit_file" "$node_bin"   # use the existing unit-write helper, whatever it's named
  systemctl --user daemon-reload
  systemctl --user restart "$SYSTEMD_UNIT" 2>/dev/null || true
  ok "unit healed (backup saved alongside)"
}
```

Adjust `write_unit` to the actual function name in `deploy-linux.sh` (it may be inline inside `cmd_setup` rather than a separate function — if so, extract it first into `write_unit` before adding the self-heal).

- [ ] **Step 5: Wire `ensure_unit_healthy` into `cmd_deploy`**

In `cmd_deploy`, find where `cmd_kickstart` is called (or the equivalent). Add this line BEFORE the kickstart:

```bash
ensure_unit_healthy
```

- [ ] **Step 6: Syntax check**

```bash
bash -n scripts/deploy-linux.sh && echo "syntax ok"
```

Expected: "syntax ok"

- [ ] **Step 7: Run the JS test suite (confirm no regressions)**

```bash
npm test 2>&1 | tail -5
```

Expected: same green status as before.

- [ ] **Step 8: Commit**

```bash
git add scripts/deploy-linux.sh
git commit -m "feat(lifecycle-linux): systemd unit uses shim + --prod flag, add self-heal"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/troubleshooting.md`

- [ ] **Step 1: Add Linux subsection to CLAUDE.md**

The "## Prod/dev coordination" section already has `### macOS (launchd)` and `### Windows (Task Scheduler)` subsections. Add a third subsection AFTER Windows (before the next `##` heading):

```markdown
### Linux (systemd --user)

The same lifecycle module is implemented for Linux via `src/lifecycle/systemd.ts`. `getSupervisor()` in `src/lifecycle/platform.ts` picks the systemd backend on `process.platform === "linux"`.

**Components on Linux:**
- **Same shim as macOS.** The systemd unit's `ExecStart` invokes `~/.threadbase/launchd-entry.cjs`, which the streamer's tsup build produces as a portable CJS bundle. The shim's decision logic is identical to macOS — the platform guard allows both `darwin` and `linux`.
- **`Restart=on-failure` in the unit** mirrors macOS's `KeepAlive: SuccessfulExit=false` semantics — a clean shim exit 0 does NOT trigger systemd respawn; only non-zero exits do. This is the mechanism that keeps prod down after a clean dev exit when the marker is `userHeld: true`.
- **Unit** named `threadbase.service` (overridable via `THREADBASE_SYSTEMD_UNIT` env var). Registered by `scripts/deploy-linux.sh setup`. Lives at `~/.config/systemd/user/threadbase.service`.
- **Marker + prefs files** at `~/.threadbase/prod-suspended.json` and `dev-prefs.json` — same shape as the other platforms.

**Don't break without coordination:**
- The unit's `ExecStart` must invoke the shim (`$INSTALL_DIR/launchd-entry.cjs`), not `cli.js` directly. `ensure_unit_healthy` in `scripts/deploy-linux.sh` self-heals stale layouts.
- `Restart=on-failure` is load-bearing. Switching to `Restart=always` would cause systemd to respawn the streamer even after a clean dev exit, defeating the marker suppression. Tests in CI cannot catch this.
- The `SYSTEMD_UNIT` constant in `src/lifecycle/constants.ts` must match the unit name written by `deploy-linux.sh`. Both default to `"threadbase.service"` and both honour the `THREADBASE_SYSTEMD_UNIT` env var.
```

- [ ] **Step 2: Add Linux entries to troubleshooting.md**

In `docs/troubleshooting.md`, find the "## Prod/dev coordination" section. The existing `*(macOS)*` and `*(Windows)*` entries are intermingled — add three Linux entries at the end of the section, before the next `##` heading:

```markdown
### `tb-streamer prod status` reports `agent: NOT loaded` after deploy *(Linux)*

**When:** `scripts/deploy-linux.sh` finished without errors, but `tb-streamer prod status` reports the unit isn't loaded.
**Cause:** Either the unit was disabled by `tb-streamer prod stop`, or `THREADBASE_SYSTEMD_UNIT` is set in one shell but not in the shell where you ran the status command.
**Diagnosis:** `systemctl --user list-unit-files threadbase.service` — if it returns the unit with `State: disabled`, run `tb-streamer prod start` to enable + start. If it reports "no unit files matched", run `scripts/deploy-linux.sh setup` to register it.

---

### `tb-streamer prod start` reports systemd unit not enabled, but `systemctl --user status` shows it running *(Linux)*

**When:** systemctl reports the unit as `active (running)`, but `tb-streamer prod status` says `agent: NOT loaded`.
**Cause:** The user's session bus isn't reachable from the shell that ran `tb-streamer`. Common scenario: SSH session into a headless server where `loginctl enable-linger <user>` was never run, so user-level systemd units don't persist outside an active login session.
**Fix:** `loginctl enable-linger $USER` and re-deploy. Or, accept that prod only runs while you're logged in — use `systemctl --system` (root-level) units instead. The lifecycle module is designed for the `--user` model; system-level units require manual changes.

---

### Shim exits with "platform-mismatch" on Linux *(Linux)*

**When:** systemd logs show the streamer starting and immediately exiting. `journalctl --user -u threadbase` shows `WARN shim only runs on macOS (launchd) or Linux (systemd). Current platform: ...`.
**Cause:** The shim's platform guard rejected the current process.platform. This shouldn't happen on a regular Linux distro — `process.platform === "linux"` for any glibc/musl Linux. Possible if Node is running under WSL1 (which reports `linux` correctly — likely fine) or under an exotic Node port.
**Diagnosis:** `node -e "console.log(process.platform)"` from the same shell systemd runs the unit as. If it doesn't print `linux`, the Node binary is misconfigured.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/troubleshooting.md
git commit -m "docs(lifecycle-linux): document systemd --user backend + troubleshooting"
```

---

### Task 8: Full verification

- [ ] **Step 1: Run all tests**

Run: `npm test 2>&1 | tail -10`
Expected: All Windows-era tests pass (currently 450 on macOS). Linux-specific tests gated with `it.runIf` are skipped on macOS but pass on Linux CI.

- [ ] **Step 2: Run lint**

Run: `npm run lint 2>&1 | tail -5`
Expected: 0 new errors.

- [ ] **Step 3: Build**

Run: `npm run build 2>&1 | tail -5`
Expected: `dist/cli.cjs` and `dist/launchd-entry.cjs` produced.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(lifecycle-linux): post-suite fixes"
# (or skip if nothing to fix)
```

---

### Task 9: Manual Linux verification *(human-driven)*

This task does not modify code. It deploys the work to a real Linux machine and exercises every flow against real systemd. Analogous to Task 14 in the macOS plan and the Windows test guide.

- [ ] **Step 1: Deploy on a Linux machine**

```bash
cd ~/path/to/tb-streamer
git fetch && git checkout feat/streamer-lifecycle-coordination
git pull
bash scripts/deploy-linux.sh
```

`ensure_unit_healthy` should detect the old unit (which still points at `cli.js`) and rewrite it. Verify the new unit:

```bash
cat ~/.config/systemd/user/threadbase.service
```

The `ExecStart` line should be:
```
ExecStart=/usr/bin/node /home/<you>/.threadbase/launchd-entry.cjs serve --port 8766 --verbose --prod
```

- [ ] **Step 2: Verify prod is healthy**

```bash
tb-streamer prod status
# Expected: agent: loaded, pid: <some N>, marker: none

curl -fsS http://localhost:8766/healthz
# Expected: {"ok":true,"version":"..."}
```

- [ ] **Step 3: Verify dev-mode prompt fires on conflict**

In a new terminal, in any git repo:
```bash
cd ~/projects/any-git-repo
tb-streamer serve --port 8766
# Expected: interactive prompt
# Pick [p], then [N].
```

- [ ] **Step 4: Verify `--replace-prod`**

```bash
tb-streamer serve --port 8766 --replace-prod
# Expected: no prompt; dev binds 8766 immediately.

# In another terminal:
tb-streamer prod status
# Expected: agent: NOT loaded, marker: userHeld=false, devPid=<dev pid>
```

- [ ] **Step 5: Verify clean exit → userHeld=true**

```bash
# Ctrl-C the dev from Step 4.
tb-streamer prod status
# Expected: marker: userHeld=true
systemctl --user is-active threadbase.service
# Expected: inactive (because the shim exited 0 with Restart=on-failure)
```

- [ ] **Step 6: Verify `prod start` restores**

```bash
tb-streamer prod start
sleep 2
tb-streamer prod status
# Expected: agent: loaded, marker: none
curl -fsS http://localhost:8766/healthz
# Expected: 200 OK
```

- [ ] **Step 7: Verify crash recovery**

```bash
tb-streamer serve --port 8766 --replace-prod &
DEV_PID=$!
sleep 2
tb-streamer prod status   # marker.userHeld=false, devPid=$DEV_PID
kill -9 $DEV_PID
sleep 2
# systemd's Restart=on-failure won't restart on SIGKILL because the unit was
# unloaded by takeoverProd. The user must start it manually:
tb-streamer prod start
sleep 2
tb-streamer prod status
# Expected: agent: loaded, marker: none (cleared by the shim's crash-recovery branch on next launch)
```

NOTE on Linux crash recovery vs. macOS: on macOS, launchd will retry start automatically after a process death (with `ThrottleInterval=10`). On Linux with `Restart=on-failure`, systemd does retry on non-zero exit, but `takeoverProd` ran `bootoutAgent()` which `systemctl --user disable`'d the unit — so the retry never fires until `bootstrapAgent` (i.e. `tb-streamer prod start`) re-enables it. This is a known semantic difference between platforms.

- [ ] **Step 8: Verify `prod doctor`**

```bash
echo '{"devPid":999999,"port":8766,"repoToplevel":"/x","suspendedAt":"2026-05-30T19:55:00.000Z","userHeld":false,"shimVersion":1}' > ~/.threadbase/prod-suspended.json
tb-streamer prod doctor
# Expected: findings list "stale marker (dev pid 999999 dead)"
tb-streamer prod doctor --fix
ls ~/.threadbase/prod-suspended.json 2>&1
# Expected: No such file or directory
```

- [ ] **Step 9: Document any discoveries**

If a step surfaced an undocumented failure mode, add an entry to `docs/troubleshooting.md` under "Prod/dev coordination" with a `*(Linux)*` suffix. Commit:

```bash
git add docs/troubleshooting.md
git commit -m "docs(lifecycle-linux): document <issue> discovered during manual verification"
```

---

## Self-Review

Spec coverage:
- ✅ Supervisor backend for Linux — Task 2.
- ✅ Platform dispatcher routes to systemd on linux — Task 3.
- ✅ Shim allowed to run on Linux — Task 4.
- ✅ Error messages mention systemd + deploy-linux.sh — Task 5.
- ✅ Unit file points at shim + carries `--prod` — Task 6.
- ✅ Unit self-heal (`ensure_unit_healthy`) — Task 6.
- ✅ Documentation — Task 7.
- ✅ Manual verification — Task 9.

Placeholder scan: none.

Type consistency: `SYSTEMD_UNIT` defined once in Task 1, referenced by Tasks 2, 5, 7. `Supervisor` interface unchanged from existing.

Known gaps consciously deferred:
- **Crash recovery semantics differ from macOS.** On Linux, `bootoutAgent` disables the unit, so `Restart=on-failure` won't retry until `prod start` re-enables it. macOS's `KeepAlive` does keep retrying. Documented in Task 9 Step 7. If this becomes painful in practice, a `Restart=always` + shim-decides model is possible, but it inverts the source-of-truth: systemd would respawn even on clean exit, and the shim would always exit 0 anyway. Net effect would be many tight respawn cycles when prod is intentionally held. Not worth it for v1.
- **System-level units.** `loginctl enable-linger` is required for the unit to run when the user isn't logged in. Documented in troubleshooting. Out of scope to auto-configure (touches root state).
- **Distro variations.** Tested mental model: glibc-based distros with systemd 245+. Alpine + musl + OpenRC, NixOS, distros without `systemd --user` enabled by default: documented as unsupported, no special handling.
