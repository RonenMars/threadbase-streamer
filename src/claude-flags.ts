// Per-server Claude Code CLI flags: the allowlist registry, validation, and
// argv construction.
//
// The registry is SERVER-owned and shipped to clients (mobile) over
// `GET /api/config/claude-flags`. Mobile must not hardcode its own copy: only
// the streamer knows which `claude` binary is installed locally, so a client-side
// copy drifts the moment the CLI is upgraded — and the failure is silent (the
// phone offers a flag the local CLI rejects, and the PTY dies at spawn with a
// stderr the mobile UI never surfaces).
//
// `id` is deliberately NOT the CLI spelling. It is the stable key used in
// server.yaml and over the wire, so a future CLI rename is a one-line change
// here instead of a config migration.

/** Claude Code `--permission-mode` values, as accepted by CLI v2.1.x. */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

// Modes that disable the human-in-the-loop confirmation entirely. Two
// consequences, both load-bearing:
//   1. buildSettingsJson() adds skipDangerousModePermissionPrompt so the
//      blocking "Bypass Permissions mode" boot gate never strands the PTY.
//   2. Clients render an explicit confirmation before enabling one.
export const DANGEROUS_PERMISSION_MODES: readonly PermissionMode[] = [
  "bypassPermissions",
  "dontAsk",
];

export function isDangerousPermissionMode(mode: PermissionMode): boolean {
  return DANGEROUS_PERMISSION_MODES.includes(mode);
}

export type FlagValueType = "boolean" | "string" | "enum" | "list";

/** How risky enabling a flag is. Drives the client's confirmation UX. */
export type FlagRisk = "low" | "elevated" | "dangerous";

export interface FlagDefinition {
  /** Stable config/wire key. Never the CLI spelling. */
  id: string;
  /** The literal CLI token, e.g. "--add-dir". */
  flag: string;
  valueType: FlagValueType;
  /** Allowed values when valueType === "enum". */
  enumValues?: readonly string[];
  /**
   * Baseline risk. `permissionMode` is the exception: it is only dangerous for
   * the values in DANGEROUS_PERMISSION_MODES, so clients must call
   * `flagValueRisk()` rather than reading this field directly.
   */
  risk: FlagRisk;
}

export type ClaudeFlagValue = string | string[] | boolean;
export type ClaudeFlagValues = Record<string, ClaudeFlagValue>;

// v1 allowlist. Every argv form here was verified against Claude Code v2.1.218.
//
// Deliberately excluded:
//   --append-system-prompt  collides with the existing defaultSystemPrompt /
//                           options.systemPrompt path; two writers of the system
//                           prompt is a bug waiting to happen.
//   --allow-dangerously-skip-permissions
//                           a strictly weaker duplicate of
//                           `--permission-mode bypassPermissions`; two paths to
//                           one outcome is worse than one.
//   --bare, --agent         no demonstrated need.
// All three remain reachable through the free-text extra-args escape hatch.
export const CLAUDE_FLAGS: readonly FlagDefinition[] = [
  {
    id: "permissionMode",
    flag: "--permission-mode",
    valueType: "enum",
    enumValues: PERMISSION_MODES,
    risk: "low",
  },
  { id: "addDir", flag: "--add-dir", valueType: "list", risk: "elevated" },
  { id: "allowedTools", flag: "--allowedTools", valueType: "list", risk: "elevated" },
  { id: "disallowedTools", flag: "--disallowedTools", valueType: "list", risk: "low" },
  { id: "maxBudgetUsd", flag: "--max-budget-usd", valueType: "string", risk: "low" },
  { id: "fallbackModel", flag: "--fallback-model", valueType: "string", risk: "low" },
];

export function findFlag(id: string): FlagDefinition | undefined {
  return CLAUDE_FLAGS.find((f) => f.id === id);
}

/**
 * Effective risk of a specific value. Only `permissionMode` is value-dependent
 * (`acceptEdits` is routine; `bypassPermissions` is not).
 */
export function flagValueRisk(id: string, value: ClaudeFlagValue): FlagRisk {
  const def = findFlag(id);
  if (!def) return "low";
  if (def.id === "permissionMode") {
    return isPermissionMode(value) && isDangerousPermissionMode(value) ? "dangerous" : "low";
  }
  return def.risk;
}

/**
 * Drop everything that isn't a known id carrying a well-typed value.
 *
 * This is a TRUST BOUNDARY, not a convenience: values arrive from a
 * user-editable server.yaml and from HTTP, and they become process argv. Never
 * skip it. Unknown/invalid entries are dropped rather than throwing so one bad
 * key can't prevent the server from booting.
 */
export function validateFlagValues(raw: unknown): ClaudeFlagValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ClaudeFlagValues = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = findFlag(id);
    if (!def) continue;
    switch (def.valueType) {
      case "boolean":
        if (typeof value === "boolean") out[id] = value;
        break;
      case "enum":
        if (typeof value === "string" && def.enumValues?.includes(value)) out[id] = value;
        break;
      case "string":
        if (typeof value === "string" && value.trim().length > 0) out[id] = value.trim();
        break;
      case "list": {
        if (!Array.isArray(value)) break;
        const items = value
          .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
          .map((v) => v.trim());
        if (items.length > 0) out[id] = items;
        break;
      }
    }
  }
  return out;
}

/**
 * Split a free-text extra-args string into argv tokens, honouring single and
 * double quotes so a path with spaces survives. Deliberately not a full shell
 * parser — no variable expansion, no globbing, no escapes beyond the quotes.
 */
export function tokenizeExtraArgs(input: string | undefined): string[] {
  if (!input) return [];
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Turn validated flag values + extra args into argv tokens.
 *
 * `permissionMode` is intentionally NOT emitted here: both PTY spawn paths
 * already pass `--permission-mode` as an explicit positional, and emitting it
 * twice would put a duplicate flag on the command line. It flows through
 * `options.permissionMode` instead.
 *
 * Extra args land LAST so the escape hatch can override anything the allowlist
 * set.
 */
export function buildFlagArgs(values: ClaudeFlagValues | undefined, extraArgs?: string): string[] {
  const args: string[] = [];
  const safe = validateFlagValues(values ?? {});

  for (const def of CLAUDE_FLAGS) {
    if (def.id === "permissionMode") continue;
    const value = safe[def.id];
    if (value === undefined) continue;
    if (def.valueType === "boolean") {
      if (value === true) args.push(def.flag);
      continue;
    }
    if (Array.isArray(value)) {
      // Variadic form (`--allowedTools A B`) — verified against v2.1.218.
      args.push(def.flag, ...value);
      continue;
    }
    args.push(def.flag, String(value));
  }

  args.push(...tokenizeExtraArgs(extraArgs));
  return args;
}

// The `--settings` JSON every PTY session is spawned with.
//
// `skipDangerousModePermissionPrompt` is the fix for the blocking
// "Bypass Permissions mode" warning menu ("1. No, exit" / "2. Yes, I accept").
// Without it a bypass-mode session stalls on that gate forever and mobile shows
// an empty screen. Probe-verified on Claude Code v2.1.218: with the key set the
// session boots straight to a usable prompt. Only added for the modes that can
// actually trigger the gate, so a normal session's settings blob is unchanged.
export function buildSettingsJson(permissionMode: PermissionMode): string {
  const settings: Record<string, unknown> = { spinnerTipsEnabled: false };
  if (isDangerousPermissionMode(permissionMode)) {
    settings.skipDangerousModePermissionPrompt = true;
  }
  return JSON.stringify(settings);
}
