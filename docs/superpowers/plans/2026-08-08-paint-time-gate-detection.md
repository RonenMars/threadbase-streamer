# Paint-Time Permission-Gate Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broadcast the `permission` WS event at gate-paint time (~10–300 ms) instead of waiting ~6 s for Claude Code's debounced OSC 777 notify.

**Architecture:** Three additive changes to the existing detection pipeline: (1) a raw-byte tail carried across PTY chunks so a split OSC escape still matches; (2) a per-session 300 ms throttle that lets a chunk's arrival alone trigger a full rendered-screen detection pass; (3) a new pure classifier that claims a permission gate from the rendered screen (gate footer + numbered Yes/No options) without the OSC. Everything downstream — broadcast payload, dedupe, close logic, subscribe replay, mobile — is untouched.

**Tech Stack:** TypeScript, vitest (globals enabled — never import `describe`/`it`/`expect`), `@xterm/headless` (already wired), mocked `node-pty` in tests.

**Spec:** `docs/superpowers/specs/2026-08-08-paint-time-gate-detection-design.md` (read it first; it carries the prod-log measurement that motivates every number here).

## Global Constraints

- Work only in the worktree `/Users/ronenmars/dev/ai-tools/tb-streamer-worktrees/feat-paint-time-gate-detection` (branch `feat/paint-time-gate-detection`). Never touch the root checkout, never push to `main`.
- Before EVERY `git commit`: show the staged diff and the exact commit message, and wait for explicit user approval (global rule — applies even though this plan says "Commit").
- Conventional commit titles; no AI attribution anywhere.
- Use `/opt/homebrew/bin/git` (a shell function shadows `git` on this machine).
- Use the Node version in `.nvmrc` (`nvm use`) — `better-sqlite3` ABI mismatches otherwise.
- Run single test files with `npx vitest run __tests__/<file>.test.ts`; capture full-suite output to a file (`npm test > /tmp/test-out.txt 2>&1`) — this machine fails ~13 unrelated suite tests under load, so compare failures against base before blaming a change.
- Task order is load-bearing: Task 2 (tail-carry) MUST land before Task 3 (throttle + screen claim), otherwise Task 2's regression test goes green for the wrong reason (the screen classifier would rescue the split-OSC fixture if it carried a gate footer, and the no-trigger red state assumes no throttle exists yet).
- Mobile compatibility: no WS event shape changes of any kind are allowed by this plan. The `permission` payload must remain byte-identical in shape.

## Reference: current behavior (all in `src/pty-manager.ts` unless noted)

- `handleOutput` (`:752`) runs per chunk: ring buffer → `session.screen.write(data)` → status marker check → `onOutput` (terminal broadcast) → fire-and-forget `detectLivePrompts(sessionId, data, stripped)` (`:815`) → re-arm 500 ms quiet checker.
- `detectLivePrompts` (`:839`) computes `oscPermission`/`oscWaitingForInput` from the RAW chunk (`:847-851`), cheap chunk-level hints (`hasAskFooter`, `hasPromptMarker`, `hasShellPromptHint`), then early-returns (`:870-880`) unless a trigger fired or a prompt is already open. Past the gate it awaits `getOutputLines(sessionId, 60)` (xterm write-queue flush + rendered lines) and runs three branches: permission gate (OSC-triggered, `:912-932`), AskUserQuestion menu (`:939-955`), unstructured shell prompt (`:962-979`).
- `handleQuiet` (`:986`) re-runs detection 500 ms after the last chunk but ONLY when `status === "running"` — a painted gate flips status to `waiting_input` via the `❯`/`╭` markers in the same chunk, so quiet re-detection never fires for gates. Do not change this; the throttle replaces it for this purpose.
- Pure detectors live in `src/services/questions/`: `detectPermissionGate.ts` (OSC regexes + `scrapePermissionGate` + `PermissionGate`/`PermissionOption` types), `detectQuestionFromScreen.ts` (Ask menus; its `PERMISSION_LABEL_RE = /^(Yes|No)\b/i` rejects gates), `detectShellPrompt.ts` (bails when Claude box chrome is on screen — `CLAUDE_CHROME_RE`).
- Per-session cleanup sites that every new Map must join: `putOnHold` block (`:631-632`, next to `this.permissionOpen.delete(sessionId)`), `handleExit` (`:1128-1131`), `dispose()` (`:747-749`, `.clear()` calls).
- Test harness to copy: `__tests__/pty-shell-prompt-detection.test.ts` — mocks `node-pty` with an EventEmitter process, spawns via `mgr.startFresh({...})`, feeds chunks with `proc._emit("data", ...)`, settles with `await new Promise((r) => setTimeout(r, 10))`.

---

### Task 1: `detectGateScreen` — pure OSC-less gate classifier

**Files:**
- Modify: `src/services/questions/detectPermissionGate.ts` (add regexes + one exported function at the end of the file)
- Test: `__tests__/detect-gate-screen.test.ts` (new)

**Interfaces:**
- Consumes: `scrapePermissionGate(lines: string[]): PermissionGate | null` and the `PermissionGate` interface, both already exported from the same file.
- Produces: `detectGateScreen(lines: string[]): PermissionGate | null` — exported; returns the scraped gate only when the rendered screen carries the full gate signature; `null` otherwise. Task 3 imports this by name.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/detect-gate-screen.test.ts`:

```typescript
import { detectGateScreen } from "../src/services/questions/detectPermissionGate";

// Rendered-screen form of a real Bash-approval gate (post-xterm lines, box
// gutters intact) — mirrors the prod gate measured in the 2026-08-08 spec.
const GATE_SCREEN = [
  "╭────────────────────────────────────────────────────╮",
  "│ Bash command                                       │",
  "│   /opt/homebrew/bin/git reflog -8                  │",
  "│   Locate integration branch and its state          │",
  "│ This command requires approval                     │",
  "│                                                    │",
  "│ Do you want to proceed?                            │",
  "│ ❯ 1. Yes                                           │",
  "│   2. Yes, and don't ask again for: git reflog *    │",
  "│   3. No                                            │",
  "│                                                    │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain   │",
  "╰────────────────────────────────────────────────────╯",
];

describe("detectGateScreen", () => {
  it("claims a painted gate: footer + numbered Yes/No options (positive control)", () => {
    const gate = detectGateScreen(GATE_SCREEN);
    expect(gate).toBeTruthy();
    expect(gate?.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and don't ask again for: git reflog *",
      "No",
    ]);
    expect(gate?.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(gate?.cursor).toBe(1);
    expect(gate?.prompt).toBe("Do you want to proceed?");
  });

  // Each negative below is the SAME fixture with exactly one anchor flipped —
  // the positive control above proves the base fixture fires, so a null here
  // is attributable to the flipped anchor alone.

  it("stays silent without the gate footer", () => {
    const noFooter = GATE_SCREEN.filter((l) => !/Esc to cancel/i.test(l));
    expect(detectGateScreen(noFooter)).toBeNull();
  });

  it("stays silent when options are not the Yes/No family (prose numbered list)", () => {
    const prose = GATE_SCREEN.map((l) =>
      l
        .replace("❯ 1. Yes  ", "❯ 1. Alpha")
        .replace("2. Yes, and don't ask again for: git reflog *", "2. Beta                                       ")
        .replace("3. No ", "3. Gam"),
    );
    expect(detectGateScreen(prose)).toBeNull();
  });

  it("defers to the AskUserQuestion path when its footer is on screen", () => {
    const askScreen = [
      ...GATE_SCREEN.slice(0, -1),
      "│ Enter to select · Tab/Arrow keys to navigate · Esc to cancel │",
      GATE_SCREEN[GATE_SCREEN.length - 1],
    ];
    expect(detectGateScreen(askScreen)).toBeNull();
  });

  it("requires at least two options", () => {
    const oneOption = GATE_SCREEN.filter(
      (l) => !l.includes("2. Yes, and don't ask again") && !l.includes("3. No"),
    );
    expect(detectGateScreen(oneOption)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/detect-gate-screen.test.ts`
Expected: FAIL — `detectGateScreen` is not exported (`is not a function` / has no export member).

- [ ] **Step 3: Implement `detectGateScreen`**

Append to `src/services/questions/detectPermissionGate.ts` (after `scrapeDetail`):

```typescript
// ── Paint-time gate signature ──────────────────────────────────────
// The OSC 777 notify is debounced ~6s by Claude Code (measured 2026-08-08,
// see docs/superpowers/specs/2026-08-08-paint-time-gate-detection-design.md),
// so waiting for it makes the mobile card lag a fully painted gate. This
// classifier claims a gate from the RENDERED screen alone. All three anchors
// must hold — the Yes/No label test is what keeps a numbered list in Claude's
// prose from opening a card.

// Gate footer ("Esc to cancel · Tab to amend · ctrl+e to explain"); "esc to
// cancel" is the stable core across versions.
const GATE_FOOTER_RE = /esc to cancel/i;
// AskUserQuestion footer — that path has priority (its footer also contains
// "Esc to cancel", so this must be tested first).
const ASK_MENU_FOOTER_RE = /Enter to select/i;
// Same family test detectQuestionFromScreen uses in reverse to REJECT gates.
const YES_NO_LABEL_RE = /^(yes|no)\b/i;

/**
 * Claim a permission gate from rendered screen lines without an OSC 777.
 * Returns the scraped gate when the full gate signature is present:
 * ≥2 numbered options, the gate footer, no Ask-menu footer, and at least one
 * Yes/No-family option label. Pure — no I/O.
 */
export function detectGateScreen(lines: string[]): PermissionGate | null {
  if (lines.some((l) => ASK_MENU_FOOTER_RE.test(l))) return null;
  if (!lines.some((l) => GATE_FOOTER_RE.test(l))) return null;
  const gate = scrapePermissionGate(lines);
  if (!gate || gate.options.length < 2) return null;
  if (!gate.options.some((o) => YES_NO_LABEL_RE.test(o.label))) return null;
  return gate;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/detect-gate-screen.test.ts`
Expected: PASS (5/5). If the positive control fails on `prompt` or `cursor`, debug `scrapePermissionGate` expectations against the fixture — do NOT weaken the assertions.

- [ ] **Step 5: Run the neighboring detector suites (regression)**

Run: `npx vitest run __tests__/detect-permission-gate.test.ts __tests__/detect-question-from-screen.test.ts __tests__/detect-shell-prompt.test.ts`
Expected: PASS — Task 1 adds code but changes none.

- [ ] **Step 6: Commit (after showing diff + message and getting user approval)**

```bash
/opt/homebrew/bin/git add src/services/questions/detectPermissionGate.ts __tests__/detect-gate-screen.test.ts
/opt/homebrew/bin/git commit -m "feat(questions): add screen-signature permission gate classifier"
```

---

### Task 2: OSC tail-carry across chunk boundaries

**Files:**
- Modify: `src/pty-manager.ts` (constant near `QUIET_DETECT_MS` at `:61`; map declaration; `detectLivePrompts` OSC lines `:847-851`; three cleanup sites)
- Test: `__tests__/pty-osc-tail-carry.test.ts` (new)

**Interfaces:**
- Consumes: `hasPermissionOsc(raw: string): boolean`, `hasWaitingForInputOsc(raw: string): boolean` (already imported in `pty-manager.ts`).
- Produces: no new exports. Behavioral contract for later tasks: `oscPermission`/`oscWaitingForInput` inside `detectLivePrompts` are computed from `previous-chunk tail + current chunk`, and the tail is consumed on a match (so the quiet path, which passes `rawData=""`, can never re-fire a consumed escape).

- [ ] **Step 1: Write the failing test**

Create `__tests__/pty-osc-tail-carry.test.ts`:

```typescript
import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { PermissionOption } from "../src/services/questions/detectPermissionGate";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 12345,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

type Gate = { prompt?: string; options: PermissionOption[]; cursor?: number } | null;

function getMockProc(mgr: PTYManager, sessionId: string): { _emit: (e: string, d: string) => void } {
  const m = mgr as any;
  return m.sessions.get(sessionId).process;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

// Box-guttered options: the │ gutter keeps the chunk-level shell-prompt hint
// from firing AND makes detectShellPrompt bail on Claude chrome — so with a
// split (unmatched) OSC, NOTHING detects this gate today. No gate footer on
// purpose: once Task 3 lands, a footer would let the screen classifier claim
// it and mask a tail-carry regression.
const GATE_OPTIONS =
  "\r\n│ Do you want to proceed?  │" +
  "\r\n│ ❯ 1. Yes                 │" +
  "\r\n│   2. No                  │\r\n";

describe("PTYManager — OSC 777 split across chunk boundaries", () => {
  it("fires the permission gate when the notify escape is split mid-sequence", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    // The ~54-byte escape cut mid-word: neither half matches the OSC regex.
    proc._emit("data", "\x1b]777;notify;Claude Code;Claude nee");
    await settle();
    proc._emit("data", "ds your permission\x07" + GATE_OPTIONS);
    await settle();

    const gate = gates.find((g) => g && g.options.length === 2);
    expect(gate).toBeTruthy();
    expect(gate?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    mgr.dispose();
  });

  it("still fires when the escape arrives whole (positive control for the harness)", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    proc._emit(
      "data",
      "\x1b]777;notify;Claude Code;Claude needs your permission\x07" + GATE_OPTIONS,
    );
    await settle();

    expect(gates.find((g) => g && g.options.length === 2)).toBeTruthy();
    mgr.dispose();
  });

  it("closes the gate when the waiting-for-input notify is split mid-sequence", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    // Open via a WHOLE permission notify (known-good path)…
    proc._emit(
      "data",
      "\x1b]777;notify;Claude Code;Claude needs your permission\x07" + GATE_OPTIONS,
    );
    await settle();
    expect(gates.some((g) => g && g.options.length === 2)).toBe(true);

    // …then split the CLOSE notify. Without tail-carry neither half matches,
    // and the still-painted options make the open-gate branch re-affirm the
    // gate instead of closing it.
    proc._emit("data", "\x1b]777;notify;Claude Code;Claude is wait");
    await settle();
    proc._emit("data", "ing for your input\x07");
    await settle();

    expect(gates[gates.length - 1]).toBeNull();
    mgr.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify the split cases fail and the whole case passes**

Run: `npx vitest run __tests__/pty-osc-tail-carry.test.ts`
Expected: test 1 FAIL (`gate` undefined — nothing detected), test 2 PASS, test 3 FAIL (last broadcast is the re-affirmed gate, not `null`). Test 2 passing proves the fixture and harness are sound, so the reds are attributable to the splits alone.

- [ ] **Step 3: Implement the tail-carry**

In `src/pty-manager.ts`:

(a) Constant, directly under `QUIET_DETECT_MS` (`:61`):

```typescript
// Raw tail carried across chunks for the OSC 777 regexes. node-pty chunk
// boundaries are arbitrary, and the ~54-char notify escape matched NEITHER
// half when split. 128 chars covers the escape with margin, tmux-wrapped or
// not.
const OSC_TAIL_CHARS = 128;
```

(b) Map declaration, next to the existing `private permissionOpen` declaration (grep for `permissionOpen = new Set` in the class fields):

```typescript
  // Last chunk's raw tail per session — prepended to the next chunk before
  // the OSC regex test so a split escape still matches. Consumed on match.
  private oscTail = new Map<string, string>();
```

(c) Replace the two OSC lines in `detectLivePrompts` (`:847-851`). Current code:

```typescript
    const oscPermission = hasPermissionOsc(rawData);
    // Claude finished its turn. Authoritative "no gate is open" signal — it
    // arrives even when no further chunk will (the turn is over), so it is the
    // only thing that can close a gate whose options never painted.
    const oscWaitingForInput = hasWaitingForInputOsc(rawData);
```

New code:

```typescript
    // OSC escapes can split across node-pty chunk boundaries — test against
    // the previous chunk's tail + this chunk. The tail is consumed on a match
    // so the quiet path (rawData === "") can never re-fire a seen escape, and
    // left untouched by the quiet path so a pending partial isn't dropped.
    const oscWindow = (this.oscTail.get(sessionId) ?? "") + rawData;
    const oscPermission = hasPermissionOsc(oscWindow);
    // Claude finished its turn. Authoritative "no gate is open" signal — it
    // arrives even when no further chunk will (the turn is over), so it is the
    // only thing that can close a gate whose options never painted.
    const oscWaitingForInput = hasWaitingForInputOsc(oscWindow);
    if (rawData !== "") {
      if (oscPermission || oscWaitingForInput) this.oscTail.delete(sessionId);
      else this.oscTail.set(sessionId, rawData.slice(-OSC_TAIL_CHARS));
    }
```

(d) Cleanup — add one line at each of the three sites, beside the existing `permissionOpen` cleanup:
- `putOnHold` block (`:631-632`): `this.oscTail.delete(sessionId);`
- `handleExit` (`:1128-1131`): `this.oscTail.delete(sessionId);`
- `dispose()` (`:747-749`): `this.oscTail.clear();`

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npx vitest run __tests__/pty-osc-tail-carry.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Run the adjacent PTY detection suites (regression)**

Run: `npx vitest run __tests__/pty-shell-prompt-detection.test.ts __tests__/pty-live-question-close.test.ts __tests__/permission-broadcast-dedup.test.ts __tests__/pty-ready-detection.test.ts`
Expected: PASS — the OSC window equals the raw chunk whenever the previous chunk consumed or never contained an escape fragment, so existing flows are unchanged.

- [ ] **Step 6: Commit (after showing diff + message and getting user approval)**

```bash
/opt/homebrew/bin/git add src/pty-manager.ts __tests__/pty-osc-tail-carry.test.ts
/opt/homebrew/bin/git commit -m "fix(pty): carry raw tail across chunks so a split OSC 777 still fires"
```

---

### Task 3: Throttled paint-time detection + screen-claim branch

**Files:**
- Modify: `src/pty-manager.ts` (constant; map; import; early-return block `:870-880`; permission branch chain `:912-932`; three cleanup sites)
- Test: `__tests__/pty-paint-time-gate.test.ts` (new)

**Interfaces:**
- Consumes: `detectGateScreen(lines: string[]): PermissionGate | null` from Task 1 (add to the existing `detectPermissionGate` import at the top of `pty-manager.ts`, which already imports `hasPermissionOsc, hasWaitingForInputOsc, scrapePermissionGate`).
- Produces: no new exports. Behavioral contract: a painted gate broadcasts via `onPermissionChange` without any OSC in the stream, within one throttle window of its paint.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/pty-paint-time-gate.test.ts`:

```typescript
import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { PermissionOption } from "../src/services/questions/detectPermissionGate";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 12345,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

type Gate = { prompt?: string; options: PermissionOption[]; cursor?: number } | null;

function getMockProc(mgr: PTYManager, sessionId: string): { _emit: (e: string, d: string) => void } {
  const m = mgr as any;
  return m.sessions.get(sessionId).process;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

// Full gate paint as one chunk — box, prompt, options, gate footer. This is
// the regression test for the whole feature: NO OSC anywhere in the stream.
const GATE_PAINT = [
  "╭────────────────────────────────────────────────────╮",
  "│ Bash command                                       │",
  "│   /opt/homebrew/bin/git reflog -8                  │",
  "│ This command requires approval                     │",
  "│                                                    │",
  "│ Do you want to proceed?                            │",
  "│ ❯ 1. Yes                                           │",
  "│   2. Yes, and don't ask again for: git reflog *    │",
  "│   3. No                                            │",
  "│                                                    │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain   │",
  "╰────────────────────────────────────────────────────╯",
].join("\r\n");

describe("PTYManager — paint-time gate detection (no OSC)", () => {
  it("broadcasts the gate from the paint alone", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", GATE_PAINT);
    await settle();

    const gate = gates.find((g) => g && g.options.length === 3);
    expect(gate).toBeTruthy();
    expect(gate?.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(gate?.cursor).toBe(1);
    expect(gate?.prompt).toBe("Do you want to proceed?");
    mgr.dispose();
  });

  it("still closes via the waiting-for-input OSC after a paint-time open", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", GATE_PAINT);
    await settle();
    expect(gates.some((g) => g && g.options.length === 3)).toBe(true);

    proc._emit(
      "data",
      "\x1b[2J\x1b[H\x1b]777;notify;Claude Code;Claude is waiting for your input\x07",
    );
    await settle();

    expect(gates[gates.length - 1]).toBeNull();
    mgr.dispose();
  });

  it("throttles unsolicited scrapes: a second trigger-less chunk inside the window scrapes nothing", async () => {
    const mgr = new PTYManager({ onPermissionChange: () => {} });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);
    // Detection passes call getOutputLines(sessionId, 60); the quiet checker's
    // ready recheck uses maxLines 40 — filter by the 60 to count passes only.
    const spy = vi.spyOn(mgr, "getOutputLines");
    const passes = () => spy.mock.calls.filter((c) => c[1] === 60).length;

    proc._emit("data", "plain output with no prompt\r\n");
    await settle();
    expect(passes()).toBe(1); // throttle was due (first pass) — chunk alone scraped

    proc._emit("data", "more plain output\r\n");
    await settle();
    expect(passes()).toBe(1); // inside the window, no trigger — early return

    await new Promise((r) => setTimeout(r, 310));
    proc._emit("data", "later plain output\r\n");
    await settle();
    expect(passes()).toBe(2); // window elapsed — chunk alone scrapes again
    mgr.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify current behavior fails**

Run: `npx vitest run __tests__/pty-paint-time-gate.test.ts`
Expected: tests 1 and 2 FAIL (no broadcast — box gutters defeat every chunk-level trigger and there is no OSC). Test 3 FAIL (`passes()` is 0 — today a trigger-less chunk never scrapes at all; the test documents the new floor AND ceiling).

- [ ] **Step 3: Implement throttle + screen-claim branch**

In `src/pty-manager.ts`:

(a) Constant, under `OSC_TAIL_CHARS`:

```typescript
// Ceiling on unsolicited rendered-screen scrapes: a chunk's arrival alone
// may trigger a full detection pass at most this often. Exists because the
// gate paint has NO reliable chunk-level signal (the TUI paints
// cursor-addressed fragments and the box gutter defeats the hint regex)
// while Claude debounces its OSC 777 notify ~6s — see
// docs/superpowers/specs/2026-08-08-paint-time-gate-detection-design.md.
// 300ms = half the blink cadence of a waiting gate (~450-620ms observed), so
// worst-case added card latency is one tick and scrape work is ≤ ~3/s per
// active session (idle sessions emit no chunks, so they never scrape).
const SCRAPE_THROTTLE_MS = 300;
```

(b) Map declaration, next to `oscTail`:

```typescript
  // When the last full detection pass ran per session (any trigger) — the
  // clock the SCRAPE_THROTTLE_MS ceiling is measured against.
  private lastDetectAt = new Map<string, number>();
```

(c) Import: add `detectGateScreen` to the existing import from `./services/questions/detectPermissionGate` at the top of the file.

(d) Early-return block (`:870-880`). Current code:

```typescript
    if (
      !oscPermission &&
      !oscWaitingForInput &&
      !hasAskFooter &&
      !hasShellPromptHint &&
      !this.permissionOpen.has(sessionId) &&
      !this.shellPromptOpen.has(sessionId) &&
      !this.lastScreenQuestionKey.has(sessionId)
    ) {
      return;
    }
```

New code (adds `scrapeDue`, records the pass time after the gate):

```typescript
    // Paint-time throttle: when the last full pass is ≥ SCRAPE_THROTTLE_MS
    // old, a chunk's arrival alone is enough to scrape — the gate paint has
    // no reliable chunk-level signal and its OSC arrives ~6s late.
    const nowMs = Date.now();
    const scrapeDue = nowMs - (this.lastDetectAt.get(sessionId) ?? 0) >= SCRAPE_THROTTLE_MS;
    if (
      !oscPermission &&
      !oscWaitingForInput &&
      !hasAskFooter &&
      !hasShellPromptHint &&
      !scrapeDue &&
      !this.permissionOpen.has(sessionId) &&
      !this.shellPromptOpen.has(sessionId) &&
      !this.lastScreenQuestionKey.has(sessionId)
    ) {
      return;
    }
    this.lastDetectAt.set(sessionId, nowMs);
```

(e) Permission branch chain (`:912-932`). Current tail of the chain:

```typescript
    } else if (this.permissionOpen.has(sessionId) && !askFooterOnScreen) {
```

…(body unchanged)… ends with:

```typescript
      } else if (gate) {
        this.onPermissionChange?.(sessionId, gate);
      }
    }
```

Append a third arm directly after that closing brace:

```typescript
    } else if (!askFooterOnScreen) {
      // Paint-time claim: the gate is on screen but Claude's OSC 777 notify
      // (debounced ~6s upstream) hasn't arrived. detectGateScreen anchors on
      // the gate footer + a Yes/No option label so a numbered list in prose
      // can't open a card. Downstream is the OSC path unchanged — same
      // broadcast, same dedupe, same close signals.
      const gate = detectGateScreen(lines);
      if (gate) {
        this.permissionOpen.add(sessionId);
        this.onPermissionChange?.(sessionId, gate);
      }
    }
```

(The shell-prompt fallback below already skips when `this.permissionOpen.has(sessionId)` — a successful claim in the same pass makes it skip, which is correct.)

(f) Cleanup — same three sites as Task 2, beside the `oscTail` lines:
- `putOnHold` block: `this.lastDetectAt.delete(sessionId);`
- `handleExit`: `this.lastDetectAt.delete(sessionId);`
- `dispose()`: `this.lastDetectAt.clear();`

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run __tests__/pty-paint-time-gate.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Run every PTY + question suite (regression)**

Run: `npx vitest run __tests__/pty-shell-prompt-detection.test.ts __tests__/pty-live-question-close.test.ts __tests__/pty-osc-tail-carry.test.ts __tests__/permission-broadcast-dedup.test.ts __tests__/pty-ready-detection.test.ts __tests__/detect-gate-screen.test.ts __tests__/jsonl-question-suppression.test.ts __tests__/on-new-lines-question.test.ts`
Expected: PASS. Watch specifically for `pty-shell-prompt-detection.test.ts` — its y/N fixtures have no gate footer, so `detectGateScreen` must never claim them (the throttle makes trigger-less chunks scrape now, so the shell detector runs on more passes; its own conservatism is what keeps this green).

- [ ] **Step 6: Commit (after showing diff + message and getting user approval)**

```bash
/opt/homebrew/bin/git add src/pty-manager.ts __tests__/pty-paint-time-gate.test.ts
/opt/homebrew/bin/git commit -m "feat(pty): detect permission gates at paint time via throttled screen scrape"
```

---

### Task 4: Documentation + full verification

**Files:**
- Modify: `src/services/questions/detectPermissionGate.ts:1-14` (header comment)
- Modify: `src/pty-manager.ts:809-814` (trigger-list comment above the `detectLivePrompts` call)
- Modify: `CLAUDE.md` (pty-manager bullet under "Modules with non-obvious behavior")

**Interfaces:** none — comments and docs only, plus the full-suite gate.

- [ ] **Step 1: Update the `detectPermissionGate.ts` header**

Replace the header comment's first block (lines 1-14, the "Two independent signals" text) with:

```typescript
// Permission-gate detection. Three independent signals:
//
//   1. Rendered gate signature — the PRIMARY, paint-time trigger
//      (detectGateScreen): gate footer + numbered Yes/No options in the
//      rendered screen. Fires within one scrape throttle tick of the paint.
//
//   2. OSC 777 escape — the deterministic FALLBACK trigger. The PTY emits
//      `\x1b]777;notify;Claude Code;Claude needs your permission\x07`
//      (often tmux-wrapped: `\x1bPtmux;\x1b\x1b]777;notify;…\x1b\`) — but
//      ~6s AFTER the gate paints (measured 2026-08-08, see
//      docs/superpowers/specs/2026-08-08-paint-time-gate-detection-design.md).
//      Still load-bearing: it covers a gate whose options never painted, and
//      its "waiting for your input" body is the authoritative close signal.
//
//   3. Rendered option scrape — the payload builder. The gate's numbered
//      options are painted via absolute-cursor moves, so they live in the
//      rendered headless buffer (getOutputLines), not the raw byte stream. We
//      read the ACTUAL leading numbers and the `❯` cursor — the numbers are
//      NOT a stable 1-based index (a gate can show "2. Yes / 3. No"), which
//      is exactly the "2 didn't take" bug this avoids.
```

- [ ] **Step 2: Update the trigger-list comment in `pty-manager.ts`**

Replace the comment above the `detectLivePrompts` call (`:809-814`). Current text ends with "prompt-ready marker without a fresh 777 → gate may have closed." New text:

```typescript
    // Live interactive-prompt detection from the PTY stream — fires the moment
    // a prompt is on screen, independent of (and ahead of) the JSONL flush.
    // Trigger-gated with a throttle floor so we don't scrape the rendered
    // buffer on every chunk:
    //   - OSC 777 (raw byte signal, tail-carried across chunks) → gate opened.
    //   - "Enter to select" footer (AskUserQuestion menu) → structured question.
    //   - prompt-ready marker without a fresh 777 → gate may have closed.
    //   - otherwise, at most every SCRAPE_THROTTLE_MS, a chunk alone triggers
    //     a pass — how a painted gate is claimed ~6s before its OSC arrives.
```

- [ ] **Step 3: Update CLAUDE.md**

In the `pty-manager.ts` bullet under "Modules with non-obvious behavior" (currently reads "`pty-manager.ts` — spawn/resume Claude sessions via node-pty, ring buffer output (64KB cap)"), extend it to:

```markdown
- `pty-manager.ts` — spawn/resume Claude sessions via node-pty, ring buffer output (64KB cap). Permission gates are detected at paint time from the rendered screen (`detectGateScreen`: gate footer + Yes/No options, throttled to one unsolicited scrape per 300ms) because Claude Code debounces its OSC 777 notify ~6s after painting the gate; the OSC remains the fallback trigger and the close signal. OSC regexes run against the previous chunk's tail + the current chunk, so an escape split across chunk boundaries still fires.
```

- [ ] **Step 4: Full verification**

```bash
nvm use
npm run lint
npm test > /tmp/paint-time-gate-test-out.txt 2>&1; tail -30 /tmp/paint-time-gate-test-out.txt
```

Expected: lint clean; test suite matching the base-commit pass rate (this machine fails ~13 unrelated tests under load — if anything beyond the known flaky set fails, compare against a clean run of the base commit before blaming the change).

- [ ] **Step 5: Commit (after showing diff + message and getting user approval)**

```bash
/opt/homebrew/bin/git add src/services/questions/detectPermissionGate.ts src/pty-manager.ts CLAUDE.md
/opt/homebrew/bin/git commit -m "docs(questions): reflect paint-time gate triggers in comments and CLAUDE.md"
```

---

### Post-merge verification (manual, after deploy — not a plan task)

The spec's prod success criterion: after this ships and a real gate fires, re-run the log query and confirm the paint→broadcast gap collapsed from ~6 s to ≤500 ms:

```bash
rg '"event":"(pty.chunk|ws.broadcast_permission)"' ~/.threadbase/logs/stdout.log | tail -80
```

Find the gate's paint burst (the ~1 KB chunks) and the `ws.broadcast_permission` line; the broadcast must now precede the OSC 777 chunk instead of coinciding with it. Deploying the streamer is a separate, user-approved step — this plan ends at the merged PR.
