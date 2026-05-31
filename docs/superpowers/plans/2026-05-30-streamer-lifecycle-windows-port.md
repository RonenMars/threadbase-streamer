# Streamer Lifecycle: Windows Port (Task Scheduler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the lifecycle module (commits `cac66db..65beb6f` on `feat/streamer-lifecycle-coordination`) work correctly on Windows. The macOS implementation shells out to `launchctl` and `lsof`, neither of which exists on Windows. Today, on Windows, `tb-streamer serve` silently misbehaves on port conflicts and `tb-streamer prod ...` commands either fail opaquely or succeed-but-do-nothing.

**Architecture:** Add a thin platform-detection layer (`src/lifecycle/platform.ts`) that picks `launchd.ts` or a new `task-scheduler.ts` at runtime. Replace `lsof` with `Get-NetTCPConnection`. Replace `$HOME` with `os.homedir()`. Add `--prod` to the Windows `launch.cmd` so dev-takeover doesn't fire when Task Scheduler starts the streamer. Add Windows-specific test mocks. No shim binary on Windows — Task Scheduler does not auto-respawn, so the marker-suppression mechanism is not needed; the new `prod` subcommands and dev-takeover prompt are the user-visible surface.

**Tech Stack:** TypeScript / Vitest with `vi.mock` / Node `child_process.execFileSync` (running `powershell.exe -NoProfile -Command ...`) / Windows Task Scheduler cmdlets (`Get-ScheduledTask`, `Stop-ScheduledTask`, `Start-ScheduledTask`, `Disable-ScheduledTask`, `Enable-ScheduledTask`) / `Get-NetTCPConnection` for port probing.

---

## Scope check

This plan is one cohesive subsystem (Windows port of an existing module). It produces working, testable software on its own: after Task 8 every `tb-streamer prod` command works on Windows and dev-takeover prompts fire correctly. No subsystem-level split.

Out of scope (deferred):
- Windows port for the auto-update flow (`src/updater/`). That subsystem has its own platform branches and a separate plan.
- Linux port for any of the above. The lifecycle plan and this one are both macOS/Windows only because that's what the streamer ships on. A Linux port would be a third subsystem-level plan.

---

## File Structure

**New files:**
- `src/lifecycle/platform.ts` — runtime platform detection + `getSupervisor()` that returns either the launchd or task-scheduler wrapper. ~40 lines. Single responsibility: pick the right backend.
- `src/lifecycle/task-scheduler.ts` — Windows equivalent of `launchd.ts`. Same 5 exported functions, same signatures, different implementation (`Get-ScheduledTask` etc.). ~120 lines.
- `__tests__/lifecycle/task-scheduler.test.ts` — mirrors `launchd.test.ts`. Uses `vi.mock("node:child_process")`. ~80 lines.
- `__tests__/lifecycle/platform.test.ts` — verifies `getSupervisor()` picks the right module based on `process.platform`. ~40 lines.

**Modified files:**
- `src/lifecycle/constants.ts` — `installDir()` uses `os.homedir()` instead of `$HOME`, falling back to `USERPROFILE` if `homedir()` is empty (defensive — `homedir()` already handles this internally).
- `src/lifecycle/dev-takeover.ts` — `findFreePortSync` becomes platform-conditional: `lsof` on macOS/Linux, port probing via `net.createServer` on Windows. `detectProdActive` delegates to `getSupervisor().isAgentLoaded()`.
- `src/lifecycle/launchd.ts` — no functional change; just becomes one of two implementations. Add a top-of-file comment naming it the macOS implementation.
- `cli/prod.ts` — every import from `./launchd` becomes an import from `./platform` (which re-exports the right backend). The user-facing `runProdRestart` may need a Windows-specific plist-path replacement — see Task 6.
- `cli/launchd-entry.ts` — add a platform guard so that if the shim ever runs on Windows (it shouldn't be invoked by Task Scheduler, but defense-in-depth), it logs a warning and exits 0. Already inert on Windows but explicit is better.
- `scripts/deploy.ps1` — `launch.cmd` must include `--port $PORT --verbose --prod` so the Windows streamer self-identifies as prod-mode and doesn't enter dev-takeover. Add a `Repair-LaunchCmd` self-heal mirroring `ensure_plist_healthy`.
- `CLAUDE.md` — extend the "Prod/dev coordination (macOS)" section into a unified "Prod/dev coordination" with macOS and Windows subsections.
- `docs/troubleshooting.md` — add Windows-equivalent entries for the 5 lifecycle troubleshooting cases.

**Files unchanged but worth noting:**
- `cli/launchd-entry.ts` — the shim is built and shipped on every platform by tsup (it's part of the CLI tsup entry). On Windows, nothing invokes it. Keep the build; add a self-defensive `process.platform === "win32"` guard at top.
- `src/lifecycle/marker.ts`, `marker-schema.ts`, `prefs.ts`, `process-liveness.ts`, `repo.ts`, `prompt.ts` — all portable. `process.kill(pid, 0)` works on Windows; readline works; git works; file I/O works.

---

## Constants reused from existing implementation

These names are already defined in `src/lifecycle/constants.ts` and used across the lifecycle module. This plan adds nothing to that file beyond changing `installDir()` per Task 1.

- `installDir()` → currently `process.env.THREADBASE_INSTALL_DIR ?? $HOME/.threadbase`. Changes to use `os.homedir()`.
- `markerPath() / prefsPath() / activeLink()` — built on `installDir()`. No change.
- `LAUNCHD_LABEL = "com.ronen.threadbase"` — still defined for macOS use; Windows uses a separate `TASK_NAME` constant added in Task 3.
- `DEFAULT_PROD_PORT = 8766` — unchanged.

New constant added in Task 3:
- `TASK_NAME = process.env.THREADBASE_TASK_NAME ?? "Threadbase"` — must match `scripts/deploy.ps1` line 50 default. Matching env var override too.

---

## Supervisor interface (referenced by Tasks 3, 4, 5, 6)

```typescript
// src/lifecycle/platform.ts (shape — full code in Task 3)
export interface Supervisor {
  isAgentLoaded(): boolean;
  bootoutAgent(): void;
  bootstrapAgent(specPath: string): void; // macOS: plist path. Windows: ignored.
  kickstartAgent(): void;
  getAgentPid(): number | null;
}
```

Both `launchd.ts` and `task-scheduler.ts` implement this interface. `getSupervisor()` returns the right one based on `process.platform`. `cli/prod.ts` and `src/lifecycle/dev-takeover.ts` call `getSupervisor().X()` instead of importing functions directly.

Rename rationale: keeping the macOS-flavoured names ("agent", "bootout", "bootstrap", "kickstart") in the interface is intentional. Renaming them to platform-neutral names ("service", "stop", "install", "restart") would force re-reading every call site for no clarity gain. The interface name `Supervisor` makes the abstraction visible.

---

## Tasks

> **Test discipline:** Each task is TDD — failing test first, run it to confirm it fails for the expected reason, implement minimal code, run it to confirm it passes, commit. Do not advance to the next step until the current one runs successfully.

> **Commit message format:** `<type>(lifecycle-win): <description>`. Scope is `lifecycle-win` to distinguish this work from the macOS lifecycle commits.

> **Cross-platform test gotcha:** Vitest is run by CI on both macOS and Windows. Tests that mock `child_process` work on both. Tests that hit the real Task Scheduler will not work in macOS CI — and vice versa. Where a test must check Windows-specific behaviour, gate it with `it.skipIf(process.platform !== "win32")` or `vi.mock("node:child_process")`.

---

### Task 1: Make `installDir()` cross-platform

**Files:**
- Modify: `src/lifecycle/constants.ts`
- Test: `__tests__/lifecycle/constants.test.ts` (new)

The current line `process.env.THREADBASE_INSTALL_DIR ?? \`${process.env.HOME}/.threadbase\`` breaks on Windows where `HOME` is unset (Windows uses `USERPROFILE`). `os.homedir()` already returns the correct path on both platforms and falls back to `USERPROFILE` internally.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/constants.test.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDir, markerPath, prefsPath } from "../../src/lifecycle/constants";

describe("installDir()", () => {
  afterEach(() => {
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("uses THREADBASE_INSTALL_DIR override when set", () => {
    process.env.THREADBASE_INSTALL_DIR = "/tmp/override";
    expect(installDir()).toBe("/tmp/override");
  });

  it("defaults to <homedir>/.threadbase (portable, not $HOME)", () => {
    delete process.env.THREADBASE_INSTALL_DIR;
    expect(installDir()).toBe(join(homedir(), ".threadbase"));
  });

  it("markerPath() and prefsPath() build on installDir()", () => {
    process.env.THREADBASE_INSTALL_DIR = "/x";
    expect(markerPath()).toBe(join("/x", "prod-suspended.json"));
    expect(prefsPath()).toBe(join("/x", "dev-prefs.json"));
  });
});
```

Note the tests use `path.join` for cross-platform path correctness. The existing implementation hard-codes `/` as separator, which works on Windows for Node's fs APIs but is non-canonical. The implementation change should also switch to `path.join`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/lifecycle/constants.test.ts`
Expected: The "defaults to <homedir>/.threadbase" test FAILS on Windows (returns `undefined/.threadbase`) and PASSES on macOS (because `$HOME` is set to `homedir()`). The path-separator assertion FAILS on Windows (uses `/` instead of `\\`).

- [ ] **Step 3: Update `src/lifecycle/constants.ts`**

```typescript
// src/lifecycle/constants.ts
import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCHD_LABEL = "com.ronen.threadbase";
export const TASK_NAME = process.env.THREADBASE_TASK_NAME ?? "Threadbase";
export const DEFAULT_PROD_PORT = 8766;

export function installDir(): string {
  return process.env.THREADBASE_INSTALL_DIR ?? join(homedir(), ".threadbase");
}
export function markerPath(): string {
  return join(installDir(), "prod-suspended.json");
}
export function prefsPath(): string {
  return join(installDir(), "dev-prefs.json");
}
export function activeLink(): string {
  return join(installDir(), "cli.js");
}
```

Three concrete changes vs. existing file:
1. Add `import { homedir } from "node:os"` and `import { join } from "node:path"`.
2. Replace `\`${process.env.HOME}/.threadbase\`` with `join(homedir(), ".threadbase")`.
3. Replace template-literal path concatenation with `join()` in `markerPath()`, `prefsPath()`, `activeLink()`.
4. Add `export const TASK_NAME = process.env.THREADBASE_TASK_NAME ?? "Threadbase"` — used in Task 3.

- [ ] **Step 4: Run all lifecycle tests to confirm no regressions**

Run: `npx vitest run __tests__/lifecycle/`
Expected: All previously-passing tests still pass. The 3 new constants tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/constants.ts __tests__/lifecycle/constants.test.ts
git commit -m "feat(lifecycle-win): make installDir() use os.homedir() + path.join"
```

---

### Task 2: Cross-platform `findFreePortSync`

**Files:**
- Modify: `src/lifecycle/dev-takeover.ts`
- Test: `__tests__/lifecycle/find-free-port.test.ts` (new)

Current implementation calls `lsof` which doesn't exist on Windows. Replace with a portable `net.createServer().listen(port)` probe. The macOS path can keep using `lsof` for speed if you prefer, but a portable `net.createServer` probe is fine for both platforms and shorter to maintain.

Choice: go fully portable. Drop `lsof`. The probe creates a server, tries to bind, and if `EADDRINUSE` walks to the next port. Up to 50 attempts. Returns `start` if nothing free.

Sync vs async: `findFreePortSync` is called from `resolveDevPlan`. The orchestrator can already be async (it already awaits `prompt`). Change the signature to `findFreePort(start: number): Promise<number>` and update the orchestrator to `await opts.findFreePort(...)`. Tests update accordingly.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/find-free-port.test.ts
import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFreePort } from "../../src/lifecycle/dev-takeover";

function listen(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

describe("findFreePort", () => {
  let blockers: Server[] = [];
  afterEach(async () => {
    for (const s of blockers) await new Promise<void>((r) => s.close(() => r()));
    blockers = [];
  });

  it("returns the start port when it is free", async () => {
    // Use a high port unlikely to be in use.
    expect(await findFreePort(55000)).toBe(55000);
  });

  it("walks past a bound port to the next free one", async () => {
    blockers.push(await listen(55001));
    const free = await findFreePort(55001);
    expect(free).toBeGreaterThan(55001);
    expect(free).toBeLessThan(55051);
  });

  it("returns start if no free port within the 50-port window", async () => {
    // Bind 50 contiguous ports starting at 55100.
    for (let p = 55100; p < 55150; p++) blockers.push(await listen(p));
    expect(await findFreePort(55100)).toBe(55100);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/lifecycle/find-free-port.test.ts`
Expected: FAIL — `findFreePort` is not exported (the existing export is `findFreePortSync`).

- [ ] **Step 3: Update `src/lifecycle/dev-takeover.ts`**

Replace the existing `findFreePortSync` function with:

```typescript
// (existing imports above)

export function findFreePort(start: number): Promise<number> {
  return tryBind(start, 0);
}

async function tryBind(start: number, offset: number): Promise<number> {
  if (offset >= 50) return start;
  const port = start + offset;
  const free = await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
  if (free) return port;
  return tryBind(start, offset + 1);
}
```

Update the `ResolveDevPlanOpts` type:
```typescript
export type ResolveDevPlanOpts = {
  // ... existing fields ...
  findFreePort: (start: number) => Promise<number>;
};
```

And update the call site inside `resolveDevPlan`:
```typescript
  const suggested = await opts.findFreePort(opts.requestedPort + 1);
```

Remove the `import { execFileSync } from "node:child_process"` line (it was only used by `findFreePortSync`).

- [ ] **Step 4: Update existing `dev-takeover.test.ts` to use the new shape**

Inside `__tests__/lifecycle/dev-takeover.test.ts`, every `findFreePort: vi.fn()` or `findFreePort: () => 9001` becomes `findFreePort: vi.fn().mockResolvedValue(9001)` or `findFreePort: async () => 9001`. Specifically search for the 7 occurrences and update each.

- [ ] **Step 5: Update `cli/index.ts` to use the new name**

In `cli/index.ts`, find the destructure that includes `findFreePortSync` and change it to `findFreePort`. Find the call `findFreePort: findFreePortSync` and rename to `findFreePort`.

- [ ] **Step 6: Run all lifecycle tests**

Run: `npx vitest run __tests__/lifecycle/`
Expected: 3 new find-free-port tests pass. All 7 dev-takeover tests pass with the updated mocks.

- [ ] **Step 7: Lint + build**

Run: `npm run lint 2>&1 | tail -5 && npm run build 2>&1 | tail -5`
Expected: No new errors. Build still produces `dist/cli.cjs` and `dist/launchd-entry.cjs`.

- [ ] **Step 8: Commit**

```bash
git add src/lifecycle/dev-takeover.ts __tests__/lifecycle/find-free-port.test.ts __tests__/lifecycle/dev-takeover.test.ts cli/index.ts
git commit -m "feat(lifecycle-win): portable findFreePort (drop lsof dependency)"
```

---

### Task 3: Define the `Supervisor` interface + `getSupervisor()`

**Files:**
- Create: `src/lifecycle/platform.ts`
- Test: `__tests__/lifecycle/platform.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/platform.test.ts
import { describe, expect, it, vi } from "vitest";
import { getSupervisor, type Supervisor } from "../../src/lifecycle/platform";

describe("getSupervisor()", () => {
  it("returns an object that satisfies the Supervisor interface", () => {
    const sup: Supervisor = getSupervisor();
    expect(typeof sup.isAgentLoaded).toBe("function");
    expect(typeof sup.bootoutAgent).toBe("function");
    expect(typeof sup.bootstrapAgent).toBe("function");
    expect(typeof sup.kickstartAgent).toBe("function");
    expect(typeof sup.getAgentPid).toBe("function");
  });

  it.runIf(process.platform === "darwin")("picks launchd on darwin", async () => {
    const sup = getSupervisor();
    const launchd = await import("../../src/lifecycle/launchd");
    expect(sup.isAgentLoaded).toBe(launchd.isAgentLoaded);
  });

  it.runIf(process.platform === "win32")("picks task-scheduler on win32", async () => {
    const sup = getSupervisor();
    const ts = await import("../../src/lifecycle/task-scheduler");
    expect(sup.isAgentLoaded).toBe(ts.isAgentLoaded);
  });

  it.runIf(process.platform !== "darwin" && process.platform !== "win32")(
    "throws on unsupported platforms",
    () => {
      expect(() => getSupervisor()).toThrow(/unsupported/i);
    },
  );
});
```

Note: tests are platform-gated so the suite remains green on every platform. On macOS CI, the win32 test is skipped (not failed). On Windows CI, the darwin test is skipped.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/lifecycle/platform.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lifecycle/platform.ts`**

```typescript
// src/lifecycle/platform.ts
import * as launchd from "./launchd";
import * as taskScheduler from "./task-scheduler";

export interface Supervisor {
  /** True if the platform service supervisor knows about our service. */
  isAgentLoaded(): boolean;
  /** Stop & unload the supervised service. Idempotent. */
  bootoutAgent(): void;
  /**
   * Re-load the supervised service from its on-disk definition.
   * macOS: `launchctl bootstrap gui/<uid> <plist>` — `specPath` is the plist path.
   * Windows: `Enable-ScheduledTask` — `specPath` is ignored (the task is already registered).
   */
  bootstrapAgent(specPath: string): void;
  /** Restart the service (stop+start). */
  kickstartAgent(): void;
  /** PID of the running supervised service, or null. */
  getAgentPid(): number | null;
}

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

`task-scheduler.ts` doesn't exist yet — Task 4 creates it. To make this file compile in the meantime, also create a stub `src/lifecycle/task-scheduler.ts` that exports placeholders:

```typescript
// src/lifecycle/task-scheduler.ts (Task 3 stub — replaced fully in Task 4)
export function isAgentLoaded(): boolean { return false; }
export function bootoutAgent(): void {}
export function bootstrapAgent(_specPath: string): void {}
export function kickstartAgent(): void {}
export function getAgentPid(): number | null { return null; }
```

- [ ] **Step 4: Run tests to verify passing**

Run: `npx vitest run __tests__/lifecycle/platform.test.ts`
Expected: PASS — on darwin: 2 run, 2 skipped. On win32: same. On linux: 2 run (1 satisfies-interface + 1 throws), 2 skipped.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/platform.ts src/lifecycle/task-scheduler.ts __tests__/lifecycle/platform.test.ts
git commit -m "feat(lifecycle-win): add Supervisor interface + platform dispatcher"
```

---

### Task 4: Windows Task Scheduler backend (`task-scheduler.ts`)

**Files:**
- Modify: `src/lifecycle/task-scheduler.ts` (replace stub from Task 3)
- Test: `__tests__/lifecycle/task-scheduler.test.ts`

Implementation strategy: shell out to `powershell.exe -NoProfile -Command <ps1-snippet>` via `execFileSync`. Each function runs one PowerShell command. Output parsing is minimal (we check exit codes, parse a single number for `getAgentPid`).

Why `powershell.exe` and not `pwsh.exe`: Windows ships PowerShell 5.1 (`powershell.exe`) by default since Windows 10. `pwsh.exe` is PowerShell 7+ and requires a separate install. We need a built-in to keep zero-dep guarantees. All the cmdlets we call (`Get-ScheduledTask`, `Stop-ScheduledTask`, `Start-ScheduledTask`, `Disable-ScheduledTask`, `Enable-ScheduledTask`, `Get-NetTCPConnection`) exist on PS 5.1+.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/lifecycle/task-scheduler.test.ts
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
} from "../../src/lifecycle/task-scheduler";

describe("task-scheduler wrappers", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("isAgentLoaded calls Get-ScheduledTask -TaskName 'Threadbase'", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("Ready"));
    expect(isAgentLoaded()).toBe(true);
    const call = vi.mocked(execFileSync).mock.calls[0];
    expect(call[0]).toBe("powershell.exe");
    expect((call[1] as string[]).join(" ")).toMatch(/Get-ScheduledTask.*Threadbase/);
  });

  it("isAgentLoaded returns false when Get-ScheduledTask throws", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Task not found");
    });
    expect(isAgentLoaded()).toBe(false);
  });

  it("bootoutAgent runs Stop-ScheduledTask then Disable-ScheduledTask, swallows errors", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("nope");
    });
    expect(() => bootoutAgent()).not.toThrow();
  });

  it("bootstrapAgent runs Enable-ScheduledTask + Start-ScheduledTask", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    bootstrapAgent(""); // specPath unused on Windows
    const cmds = vi.mocked(execFileSync).mock.calls.map(
      (c) => (c[1] as string[]).join(" "),
    );
    expect(cmds.some((c) => /Enable-ScheduledTask/.test(c))).toBe(true);
    expect(cmds.some((c) => /Start-ScheduledTask/.test(c))).toBe(true);
  });

  it("kickstartAgent runs Stop-ScheduledTask + Start-ScheduledTask", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    kickstartAgent();
    const cmds = vi.mocked(execFileSync).mock.calls.map(
      (c) => (c[1] as string[]).join(" "),
    );
    expect(cmds.some((c) => /Stop-ScheduledTask/.test(c))).toBe(true);
    expect(cmds.some((c) => /Start-ScheduledTask/.test(c))).toBe(true);
  });

  it("getAgentPid parses the PID from Get-ScheduledTaskInfo output", () => {
    // Get-ScheduledTaskInfo emits "LastTaskResult ... NumberOfMissedRuns ..." normally.
    // We use a Select-Object -ExpandProperty Pid (custom) approach. Returns just the number.
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("12345\r\n"));
    expect(getAgentPid()).toBe(12345);
  });

  it("getAgentPid returns null when output is not a number", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    expect(getAgentPid()).toBeNull();
  });

  it("getAgentPid returns null when PowerShell errors", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(getAgentPid()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/lifecycle/task-scheduler.test.ts`
Expected: FAIL — the stub returns wrong values (isAgentLoaded → false, getAgentPid → null).

- [ ] **Step 3: Replace `src/lifecycle/task-scheduler.ts`**

```typescript
// src/lifecycle/task-scheduler.ts
import { execFileSync } from "node:child_process";
import { TASK_NAME } from "./constants";

/**
 * Windows backend for the `Supervisor` interface. Wraps the Task Scheduler
 * cmdlets via PowerShell. Counterpart of `launchd.ts` for macOS.
 *
 * Task Scheduler has no equivalent of launchd's `KeepAlive: SuccessfulExit=false`,
 * so the marker-suppression mechanism (used by the shim on macOS) does not apply
 * here. When dev exits cleanly, the prod task simply remains stopped until
 * `tb-streamer prod start` (or system reboot, if the task is at-logon-triggered).
 */
function ps(command: string): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { stdio: ["ignore", "pipe", "ignore"] },
  ).toString();
}

function psSafe(command: string): void {
  try {
    ps(command);
  } catch {
    // Intentionally swallowed — caller is one of bootout/disable variants where
    // "already gone" is the desired state.
  }
}

export function isAgentLoaded(): boolean {
  try {
    ps(`Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop | Out-Null`);
    return true;
  } catch {
    return false;
  }
}

export function bootoutAgent(): void {
  // Stop running instance + disable trigger. Mirrors macOS bootout semantics:
  // the task stays registered but will not run again until bootstrap.
  psSafe(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`);
  psSafe(`Disable-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue | Out-Null`);
}

export function bootstrapAgent(_specPath: string): void {
  // _specPath is the plist path on macOS; ignored on Windows because the task
  // is already registered by `scripts\\deploy.ps1 setup`. The caller is asking
  // us to re-enable + start it.
  ps(`Enable-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop | Out-Null`);
  ps(`Start-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`);
}

export function kickstartAgent(): void {
  psSafe(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`);
  ps(`Start-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`);
}

export function getAgentPid(): number | null {
  // Get-ScheduledTaskInfo returns the PID of the last-launched action if the
  // task is currently running. Select-Object -ExpandProperty gives us just the
  // number (or empty if absent).
  try {
    const out = ps(
      `(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop ` +
        `| Get-ScheduledTaskInfo).LastTaskResult, ` +
        `(Get-Process -Name node -ErrorAction SilentlyContinue ` +
        `| Where-Object { $_.MainWindowTitle -like '*${TASK_NAME}*' } ` +
        `| Select-Object -First 1 -ExpandProperty Id)`,
    ).trim();
    // The composed command above is unreliable for PID discovery — Get-ScheduledTaskInfo
    // does not expose the running PID directly. Fall back to a net.connect-based
    // probe in `runProdStatus` instead; this function returns null when no clean
    // PID can be determined.
    const n = Number.parseInt(out.split(/\s+/).pop() ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
```

NOTE about `getAgentPid` on Windows: Task Scheduler doesn't surface the running PID via cmdlets cleanly. There's no `Get-ScheduledTaskInfo .Pid` property. The best we can do is grep `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*cli.js*serve*' }`. Use that:

Replace `getAgentPid()` with:

```typescript
export function getAgentPid(): number | null {
  try {
    const out = ps(
      `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" ` +
        `| Where-Object { $_.CommandLine -like '*cli.js*serve*' } ` +
        `| Select-Object -First 1 -ExpandProperty ProcessId)`,
    ).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
```

This works regardless of whether the streamer was started by Task Scheduler or manually. Caveat: it returns the first matching PID even if the user has multiple streamers running, but on Windows that's already an error state.

Update the `getAgentPid` test in Step 1 to mock `Get-CimInstance` output (the test mocks `execFileSync` so the PowerShell command is opaque; the assertion just checks the parsed number).

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/lifecycle/task-scheduler.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/task-scheduler.ts __tests__/lifecycle/task-scheduler.test.ts
git commit -m "feat(lifecycle-win): implement Task Scheduler backend"
```

---

### Task 5: Route `dev-takeover.ts` and `cli/prod.ts` through `getSupervisor()`

**Files:**
- Modify: `src/lifecycle/dev-takeover.ts` (1 import + 1 call site change)
- Modify: `cli/prod.ts` (replace 5 direct imports with 1 `getSupervisor()` call)

- [ ] **Step 1: Update `src/lifecycle/dev-takeover.ts`**

Current code:
```typescript
import { bootoutAgent, isAgentLoaded } from "./launchd";
// ...
export function detectProdActive(): boolean {
  return isAgentLoaded();
}
// ... inside takeoverProd:
  bootoutAgent();
```

Change to:
```typescript
import { getSupervisor } from "./platform";
// ...
export function detectProdActive(): boolean {
  return getSupervisor().isAgentLoaded();
}
// ... inside takeoverProd:
  getSupervisor().bootoutAgent();
```

- [ ] **Step 2: Update `cli/prod.ts`**

Current imports:
```typescript
import {
  bootoutAgent, bootstrapAgent, getAgentPid, isAgentLoaded, kickstartAgent,
} from "../src/lifecycle/launchd";
```

Replace with:
```typescript
import { getSupervisor } from "../src/lifecycle/platform";
```

Every call site that used the bare function:
- `if (!isAgentLoaded())` → `if (!getSupervisor().isAgentLoaded())`
- `bootoutAgent()` → `getSupervisor().bootoutAgent()`
- `kickstartAgent()` → `getSupervisor().kickstartAgent()`
- `bootstrapAgent(plist)` → `getSupervisor().bootstrapAgent(plist)`
- `getAgentPid()` → `getSupervisor().getAgentPid()`

In `runProdRestart` (inside `registerProdCommands`), the macOS path passes a plist path to `bootstrapAgent`. On Windows, `specPath` is ignored — the existing call works unchanged because `task-scheduler.ts` ignores the argument. But the message logged after restart is macOS-specific. Update to:

```typescript
  prod
    .command("restart")
    .description("Stop + restart the supervised streamer (re-reads service definition)")
    .action(async () => {
      const sup = getSupervisor();
      sup.bootoutAgent();
      const specPath =
        process.platform === "darwin"
          ? `${process.env.HOME}/Library/LaunchAgents/com.ronen.threadbase.plist`
          : "";
      sup.bootstrapAgent(specPath);
      const what = process.platform === "darwin" ? `agent restarted from ${specPath}` : `task '${TASK_NAME}' restarted`;
      log.info(what, undefined, "console");
    });
```

Add to the top:
```typescript
import { TASK_NAME } from "../src/lifecycle/constants";
```

- [ ] **Step 3: Update `__tests__/lifecycle/prod-commands.test.ts`**

The existing test mocks `../../src/lifecycle/launchd`. Change the mock to `../../src/lifecycle/platform`:

```typescript
vi.mock("../../src/lifecycle/platform", () => ({
  getSupervisor: () => ({
    isAgentLoaded: vi.fn(() => true),
    bootoutAgent: vi.fn(),
    bootstrapAgent: vi.fn(),
    kickstartAgent: vi.fn(),
    getAgentPid: vi.fn(() => 12345),
  }),
}));
```

But the existing tests capture references to specific mock functions to assert calls. Change the approach: make `getSupervisor` return a captured object so the test can inspect calls:

```typescript
const mockSup = {
  isAgentLoaded: vi.fn(() => true),
  bootoutAgent: vi.fn(),
  bootstrapAgent: vi.fn(),
  kickstartAgent: vi.fn(),
  getAgentPid: vi.fn(() => 12345),
};

vi.mock("../../src/lifecycle/platform", () => ({
  getSupervisor: () => mockSup,
}));
```

Then update each `expect(launchd.X).toHaveBeenCalled()` to `expect(mockSup.X).toHaveBeenCalled()`. Remove the `import * as launchd from "../../src/lifecycle/launchd"` line.

The "errors when agent not loaded" test needs `mockSup.isAgentLoaded.mockReturnValue(false)` instead of the previous `vi.mocked(launchd.isAgentLoaded).mockReturnValue(false)`. Add `mockSup.isAgentLoaded.mockReturnValue(true)` reset in `beforeEach` to keep tests independent.

- [ ] **Step 4: Run all lifecycle tests**

Run: `npx vitest run __tests__/lifecycle/`
Expected: PASS — every existing test plus the new ones.

- [ ] **Step 5: Lint + build**

Run: `npm run lint 2>&1 | tail -5 && npm run build 2>&1 | tail -5`
Expected: Clean.

- [ ] **Step 6: Commit**

```bash
git add src/lifecycle/dev-takeover.ts cli/prod.ts __tests__/lifecycle/prod-commands.test.ts
git commit -m "feat(lifecycle-win): route dev-takeover + prod commands through getSupervisor()"
```

---

### Task 6: Add `--prod` to Windows `launch.cmd`

**Files:**
- Modify: `scripts/deploy.ps1` (the `Invoke-Setup` function around line 191; add `Repair-LaunchCmd` self-heal)

The current `launch.cmd` line is:
```
"$nodeBin" "$activeFile" serve
```

This invocation, when run from Task Scheduler, has no PPID 1 detection on Windows and no `--prod` flag, so the new dev-takeover branch in `cli/index.ts` will fire when the prod task starts. It will probe for prod-conflict (find nothing), and proceed normally — but the probe involves calling `getSupervisor().isAgentLoaded()` which queries its own task. False positive risk. Explicitly setting `--prod` short-circuits the entire branch.

Also missing: `--port $PORT --verbose` to match the macOS plist. The Windows path has been relying on the server.yaml default (which doesn't work — `--port` is canonical, see `CLAUDE.md` "CLI flags vs. server.yaml"). Add both.

- [ ] **Step 1: Update `Invoke-Setup`**

Find the line:
```powershell
  $cmdLines += "`"$nodeBin`" `"$activeFile`" serve"
```

Replace with:
```powershell
  $cmdLines += "`"$nodeBin`" `"$activeFile`" serve --port $port --verbose --prod"
```

Where `$port` is the deploy script's existing port variable. Search the file for the `$port` definition (around line 52 — `$port = if ($env:THREADBASE_PORT) { $env:THREADBASE_PORT } else { 8766 }` or similar). If no `$port` var exists, add one above `Invoke-Setup`:

```powershell
$port = if ($env:THREADBASE_PORT) { $env:THREADBASE_PORT } else { 8766 }
```

- [ ] **Step 2: Add `Repair-LaunchCmd` self-heal**

After `Invoke-Setup` (around line 208), add:

```powershell
# Self-heal: existing launch.cmd files from before the lifecycle work omit
# --port / --verbose / --prod. Detect + rewrite in place.
function Repair-LaunchCmd {
  $cmdPath = Join-Path $installDir 'launch.cmd'
  if (-not (Test-Path $cmdPath)) { return }

  $content = Get-Content -Path $cmdPath -Raw
  $needsRewrite = $false

  if ($content -notmatch '--prod') {
    Write-Warn "launch.cmd is missing --prod flag — rewriting"
    $needsRewrite = $true
  }
  if ($content -notmatch '--port') {
    Write-Warn "launch.cmd is missing --port flag — rewriting"
    $needsRewrite = $true
  }

  if (-not $needsRewrite) { return }

  Copy-Item -Path $cmdPath -Destination "$cmdPath.bak.$(Get-Date -Format yyyyMMddHHmmss)" -Force
  $nodeBin = (Get-Command node).Source
  $activeFile = Join-Path $installDir 'cli.js'
  $cmdLines = @('@echo off', "cd /d `"$installDir`"")
  $cmdLines += "`"$nodeBin`" `"$activeFile`" serve --port $port --verbose --prod"
  Set-Content -Path $cmdPath -Value $cmdLines -Encoding Ascii
  Write-Ok "launch.cmd healed (backup saved alongside)"
}
```

- [ ] **Step 3: Wire `Repair-LaunchCmd` into `Invoke-Deploy`**

Find `Invoke-Deploy` (line 386). After the existing release-stamping but before the kickstart, add:
```powershell
Repair-LaunchCmd
```

Place it right before `Invoke-KillStalePort` if that exists in the deploy flow, otherwise immediately before the symlink update.

- [ ] **Step 4: Syntax-check the script**

PowerShell parses on first invocation. To pre-validate without running deploy:
```bash
pwsh -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('scripts/deploy.ps1', [ref]$null, [ref]$null)"
```

(If `pwsh` is not available on the dev machine — likely macOS — skip this step; the Windows CI deploy will surface syntax errors quickly. Read the diff manually to verify brace matching.)

Expected: No syntax errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy.ps1
git commit -m "feat(lifecycle-win): add --prod/--port/--verbose to launch.cmd + Repair-LaunchCmd self-heal"
```

---

### Task 7: Defensive guard in `cli/launchd-entry.ts`

**Files:**
- Modify: `cli/launchd-entry.ts`
- Test: `__tests__/lifecycle/launchd-entry.test.ts` (extend)

The shim binary ships on every platform but is only invoked by macOS launchd. If a misconfigured Windows install somehow runs it, the shim should exit cleanly with a clear message rather than fall through to `cli.js` (which on Windows is a real file, not a symlink — the shim would `exec` it twice).

- [ ] **Step 1: Extend the failing test**

Append to `__tests__/lifecycle/launchd-entry.test.ts`:

```typescript
describe("decideShimAction on non-darwin", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns exit (with platform-mismatch reason) on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const action = decideShimAction();
    expect(action).toEqual({ kind: "exit", reason: "platform-mismatch" });
  });
});
```

Add `"platform-mismatch"` to the `ShimAction` type union and verify TS still compiles.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/lifecycle/launchd-entry.test.ts`
Expected: FAIL — the win32 case currently returns `{ kind: "exec" }`.

- [ ] **Step 3: Update `cli/launchd-entry.ts`**

Modify the `ShimAction` type:
```typescript
export type ShimAction =
  | { kind: "exec"; reason?: "crash-recovery" }
  | { kind: "exit"; reason: "user-held" | "dev-alive" | "platform-mismatch" };
```

At the top of `decideShimAction`, add:
```typescript
export function decideShimAction(): ShimAction {
  if (process.platform !== "darwin") {
    return { kind: "exit", reason: "platform-mismatch" };
  }
  // ... existing logic unchanged
```

Update `main()` to log a different message for `platform-mismatch`:
```typescript
  if (action.kind === "exit") {
    if (action.reason === "platform-mismatch") {
      log.warn(
        `shim should only run on macOS (current platform: ${process.platform}). ` +
          `On Windows, Task Scheduler runs cli.js directly. Exiting.`,
      );
    } else {
      log.info(`shim exiting (${action.reason}); launchd will not respawn (SuccessfulExit=false)`);
    }
    process.exit(0);
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/lifecycle/launchd-entry.test.ts`
Expected: PASS — 5 tests (existing 4 + 1 new).

- [ ] **Step 5: Commit**

```bash
git add cli/launchd-entry.ts __tests__/lifecycle/launchd-entry.test.ts
git commit -m "feat(lifecycle-win): shim exits on non-darwin instead of forwarding"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md` — extend the "Prod/dev coordination (macOS)" section
- Modify: `docs/troubleshooting.md` — add Windows-equivalent entries

- [ ] **Step 1: Update `CLAUDE.md`**

Rename the section heading from "## Prod/dev coordination (macOS)" to "## Prod/dev coordination".

Inside, the existing "Components" + "Marker decision table" content describes the macOS implementation. Wrap it in a "### macOS (launchd)" subsection. After it, add:

```markdown
### Windows (Task Scheduler)

The same lifecycle module is implemented for Windows via `src/lifecycle/task-scheduler.ts`. `getSupervisor()` in `src/lifecycle/platform.ts` picks the right backend at runtime.

**Components on Windows:**
- **No shim.** Task Scheduler does not auto-respawn on `KeepAlive`-style triggers (it runs the action once per trigger). The marker-suppression mechanism is unnecessary; clean dev exit simply leaves the prod task stopped.
- **Marker + prefs files** at `%USERPROFILE%\.threadbase\prod-suspended.json` and `dev-prefs.json` — same shape as macOS, used by `tb-streamer prod doctor` for diagnostics and by `--replace-prod` to track which dev session took the port.
- **Task** named `Threadbase` (overridable via `THREADBASE_TASK_NAME` env var). Registered by `scripts\deploy.ps1 setup`. Action: `wscript.exe launch.vbs` → `launch.cmd` → `node cli.js serve --port 8766 --verbose --prod`. The `--prod` flag tells the action to skip dev-takeover logic.

**Marker decision table:**
| Marker state | Effect |
|---|---|
| absent / malformed | Task runs normally on next trigger |
| `userHeld: true` | Task stays stopped until `tb-streamer prod start` |
| `userHeld: false`, devPid alive | Dev is using the port; user must stop dev or run `prod start` to force takeover back to prod |
| `userHeld: false`, devPid dead | Stale; `prod doctor --fix` clears it |

**Prod-side commands behave identically.** `tb-streamer prod start|stop|status|restart|doctor` all work; under the hood they call `Get-ScheduledTask`, `Stop-ScheduledTask`, `Start-ScheduledTask`, `Enable-ScheduledTask`, `Disable-ScheduledTask` via `powershell.exe`.

**Don't break without coordination:**
- `launch.cmd` must include `--port`, `--verbose`, and `--prod`. `Repair-LaunchCmd` in `scripts\deploy.ps1` rewrites stale layouts.
- `TASK_NAME` constant in `src/lifecycle/constants.ts` must match the task name registered by `deploy.ps1`. If you rename one, rename the other.
- `task-scheduler.getAgentPid()` greps `Get-CimInstance Win32_Process` for `node.exe` running `cli.js serve`. If you change `launch.cmd` to invoke node with a different command line, update the WMI filter to match.
```

- [ ] **Step 2: Update `docs/troubleshooting.md`**

Rename the section "## Prod/dev coordination (macOS)" to "## Prod/dev coordination". Mark the existing 5 entries' titles to indicate macOS-specificity (`*(macOS)*` suffix on each `###` line).

Add 4 new entries at the end of the section:

```markdown
### `tb-streamer prod status` reports `agent: NOT loaded` after a successful deploy *(Windows)*

**When:** `scripts\deploy.ps1` finished without errors, but `tb-streamer prod status` says the task isn't loaded.
**Cause:** Either the task name differs from `Threadbase` (e.g. `$env:THREADBASE_TASK_NAME` was set during install but not exported to the shell where you ran the status command), or the task was disabled by an earlier `tb-streamer prod stop`.
**Diagnosis:** `Get-ScheduledTask -TaskName Threadbase` from a fresh PowerShell — if it returns the task with `State: Disabled`, run `tb-streamer prod start` to re-enable + start. If it says "not found", check that `$env:THREADBASE_TASK_NAME` matches at both deploy time and runtime.

---

### `tb-streamer serve` from a dev shell hangs without printing the prompt *(Windows)*

**When:** Port 8766 is bound (prod is running). You run `tb-streamer serve` from a regular PowerShell. Nothing happens for >30s.
**Cause:** `process.platform === "win32"` so the dev branch fires, but `readline.question` is waiting on a stdin that's been redirected (e.g. running inside a non-terminal IDE pane). The prompt was emitted but the answer never arrives.
**Fix:** Run from `cmd.exe` or `powershell.exe` directly, not from VS Code's integrated terminal in a backgrounded debug session. Or pass `--replace-prod` to skip the prompt entirely.

---

### `--replace-prod` succeeds but prod restarts immediately *(Windows)*

**When:** `tb-streamer serve --replace-prod` reports "prod stopped" but within seconds the same port is reclaimed by the prod task.
**Cause:** Task Scheduler's `Stop-ScheduledTask` returns before the underlying node process exits. If your at-logon trigger has retried, a second instance can start in the window between dev's bind attempt and the OS releasing the port.
**Fix:** Add a 1-second sleep between `bootoutAgent` and the bind attempt — already done in `src/lifecycle/dev-takeover.ts` (`takeoverProd`). If you still see this, `Get-ScheduledTask -TaskName Threadbase | Select-Object State` should show `Disabled`. If it shows `Ready`, the disable failed; re-run with admin rights.

---

### `task-scheduler.getAgentPid()` returns null even though the task is running *(Windows)*

**When:** `tb-streamer prod status` shows `agent: loaded, pid: (none)`. `Get-Process node` shows a node process. `netstat -ano | findstr 8766` shows the port bound.
**Cause:** The WMI query in `getAgentPid` filters by `CommandLine -like '*cli.js*serve*'`. If `launch.cmd` was hand-edited to use a different invocation pattern, the query returns nothing.
**Fix:** Either revert `launch.cmd` to the deploy-script-generated form (run `npm run deploy` to trigger `Repair-LaunchCmd`), or update the WMI filter in `src/lifecycle/task-scheduler.ts` to match your custom command line.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/troubleshooting.md
git commit -m "docs(lifecycle-win): document Windows backend + Task Scheduler troubleshooting"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run all tests**

Run: `npm test 2>&1 | tail -10`
Expected: All 433 previously-passing tests plus the new ones (constants, find-free-port, platform, task-scheduler, +1 launchd-entry) pass. Total around 445.

- [ ] **Step 2: Run lint**

Run: `npm run lint 2>&1 | tail -5`
Expected: 0 new errors. Pre-existing warnings in `src/server.ts`, `src/session-store.ts` unchanged.

- [ ] **Step 3: Build**

Run: `npm run build 2>&1 | tail -5`
Expected: `dist/cli.cjs` and `dist/launchd-entry.cjs` produced. No warnings about missing modules.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(lifecycle-win): post-suite fixes"
# (or skip if nothing to fix)
```

---

### Task 10: Manual Windows verification *(human-driven)*

Tasks 1–9 produce code that's been verified on whichever platform the implementation is run on. The Windows-only assertions (`task-scheduler.ts` shelling out to `powershell.exe`, `Repair-LaunchCmd` in `deploy.ps1`, the `--prod` flag in `launch.cmd`) cannot be exercised on macOS — they must be tested on a real Windows machine.

Note: this is identical in spirit to Task 14 in the macOS lifecycle plan. It's separate because the test environment is different.

- [ ] **Step 1: Deploy to a Windows machine**

```powershell
cd C:\path\to\tb-streamer
git fetch && git checkout feat/streamer-lifecycle-coordination
git pull
pwsh scripts\deploy.ps1
```

`Repair-LaunchCmd` should detect the old `launch.cmd` layout and rewrite it. Verify:

```powershell
Get-Content $env:USERPROFILE\.threadbase\launch.cmd
# Last line should contain: serve --port 8766 --verbose --prod
```

- [ ] **Step 2: Verify prod is healthy**

```powershell
tb-streamer prod status
# Expected: agent: loaded, pid: <some N>, marker: none

Invoke-RestMethod http://localhost:8766/healthz
# Expected: {ok=$true; version=...}
```

- [ ] **Step 3: Verify dev-mode prompt fires on conflict**

In a new PowerShell, in any git repo:
```powershell
cd C:\Users\<you>\projects\some-repo
tb-streamer serve --port 8766
# Expected: interactive prompt asking [r]eplace prod or [p]ort 8767
# Pick [p], then [N] (don't remember).
```

- [ ] **Step 4: Verify `--replace-prod`**

```powershell
# Kill the dev from step 3 (Ctrl-C).
tb-streamer serve --port 8766 --replace-prod
# Expected: no prompt, dev binds 8766.
# In another terminal:
tb-streamer prod status
# Expected: agent: NOT loaded, marker: userHeld=false, devPid=<the dev pid>.
```

- [ ] **Step 5: Verify clean exit → marker userHeld=true**

```powershell
# Ctrl-C the dev from step 4.
tb-streamer prod status
# Expected: marker: userHeld=true.
# Verify Task Scheduler is not auto-running:
Get-ScheduledTask -TaskName Threadbase | Select-Object State
# Should show Disabled.
```

- [ ] **Step 6: Verify `tb-streamer prod start` restores**

```powershell
tb-streamer prod start
# Expected: "prod streamer restored ..."
Start-Sleep 2
tb-streamer prod status
# Expected: agent: loaded, marker: none.
Invoke-RestMethod http://localhost:8766/healthz
# Expected: 200 OK.
```

- [ ] **Step 7: Verify remembered choice**

```powershell
cd C:\Users\<you>\projects\some-repo
tb-streamer serve --port 8766
# Pick [p] for port, then [Y] to remember. Ctrl-C.
tb-streamer serve --port 8766
# Expected: no prompt, dev binds the alt port immediately.
Get-Content $env:USERPROFILE\.threadbase\dev-prefs.json
```

- [ ] **Step 8: Verify `prod doctor`**

```powershell
# Manually craft a stale marker:
'{"devPid":999999,"port":8766,"repoToplevel":"/x","suspendedAt":"2026-05-30T19:55:00.000Z","userHeld":false,"shimVersion":1}' | Set-Content $env:USERPROFILE\.threadbase\prod-suspended.json
tb-streamer prod doctor
# Expected: findings list "stale marker..." + suggestion to re-run with --fix
tb-streamer prod doctor --fix
# Expected: repairs list
Test-Path $env:USERPROFILE\.threadbase\prod-suspended.json
# Expected: False
```

- [ ] **Step 9: Document any discoveries**

If any step surfaced an undocumented failure mode, add a new entry to `docs/troubleshooting.md` under "Prod/dev coordination → Windows". Commit:

```bash
git add docs/troubleshooting.md
git commit -m "docs(lifecycle-win): document <issue> discovered during manual verification"
```

---

## Self-Review

Spec coverage check vs. the "What we actually need on Windows" list in the conversation that prompted this plan:

1. ✅ `prod status/stop/start/restart/doctor` wrapping Task Scheduler — Task 4 + Task 5.
2. ✅ Dev-takeover detecting the Task Scheduler streamer and stopping it for `--replace-prod` — Task 4 (`bootoutAgent`) + Task 5 (routes call through supervisor).
3. ✅ `findFreePortSync` portable replacement — Task 2.
4. ✅ `installDir()` using `USERPROFILE` — Task 1 (via `os.homedir()`).
5. ✅ Shim guarded against accidental Windows invocation — Task 7.
6. ✅ Documentation — Task 8.
7. ✅ `launch.cmd` carries `--prod` + `--port` + `--verbose` — Task 6.
8. ✅ `Repair-` self-heal mirroring `ensure_plist_healthy` — Task 6.

Placeholder scan: none.

Type consistency: `Supervisor` interface is the cross-task contract. Both `launchd.ts` and `task-scheduler.ts` are referenced as `import * as launchd from "./launchd"` / `import * as taskScheduler from "./task-scheduler"` in `platform.ts` — TypeScript will surface any signature mismatch between the two backends.

Open risks consciously deferred:
- **`getAgentPid` reliability on Windows** — the WMI filter approach can return wrong results if multiple node-running-cli.js processes exist. Acceptable for v1; a more robust approach (correlate by Task Scheduler's `Get-ScheduledTaskInfo` + parent-PID walking) can ship later if needed.
- **Linux support** — not in scope. `getSupervisor()` throws on Linux.
- **PowerShell startup cost** — every supervisor call spawns `powershell.exe`, ~200ms on a warm boot. `prod status` runs 3 cmdlets so it's ~600ms. Acceptable for a CLI command; if it bites for the dev-takeover hot path, batch them into one PS invocation in a later optimization.
