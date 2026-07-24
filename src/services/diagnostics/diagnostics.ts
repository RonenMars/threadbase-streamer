/**
 * Diagnostics contract (C6).
 *
 * `/healthz` answers one question — is the process up — and returns
 * `{ ok, version }`. When a user's session will not start, that tells them
 * nothing about why: the provider CLI may be missing, the database may have
 * failed to migrate, the PTY subsystem may be unavailable, or the clock may be
 * skewed enough to break token validation.
 *
 * This produces a structured report where each subsystem is checked
 * independently, so one failure never masks another, and every failure carries a
 * STABLE remediation code the client can map to instructions without parsing
 * English.
 *
 * Redaction is a contract requirement, not a nicety: this endpoint is designed
 * to be copied into a bug report. See `redactPath` below.
 */

export const DIAGNOSTICS_CONTRACT_VERSION = 1;

export type CheckStatus = "ok" | "degraded" | "failed" | "unknown";

/**
 * Stable, machine-readable remediation identifiers.
 *
 * Clients map these to localized instructions, so they are part of the contract:
 * renaming one is a breaking change. New codes may be added; existing ones must
 * keep their meaning.
 */
export type RemediationCode =
  | "PROVIDER_NOT_INSTALLED"
  | "PROVIDER_VERSION_UNVERIFIED"
  | "DB_UNAVAILABLE"
  | "DB_MIGRATION_PENDING"
  | "PTY_UNAVAILABLE"
  | "CACHE_DEGRADED"
  | "CLOCK_SKEWED"
  | "FS_SCOPE_MISSING"
  | "NONE";

export interface DiagnosticCheck {
  /** Stable identifier for the subsystem, e.g. "database". */
  id: string;
  status: CheckStatus;
  /** Human-readable summary. Never contains secrets or full paths. */
  summary: string;
  remediation: RemediationCode;
  /** Structured, redacted detail. Optional. */
  detail?: Record<string, string | number | boolean | null>;
}

export interface DiagnosticsReport {
  contractVersion: number;
  generatedAt: string;
  /** Worst status across all checks — a single field for a client to branch on. */
  overall: CheckStatus;
  checks: DiagnosticCheck[];
}

/**
 * Reduce a filesystem path to its last two segments.
 *
 * A full path leaks the user's home directory layout, their username, and often
 * client or project names. The tail is enough to recognize *which* directory is
 * meant when you already know your own machine, which is all a diagnostic needs.
 */
export function redactPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return `…/${parts.slice(-2).join("/")}`;
}

/** Worst status wins, so a single failure is never hidden by surrounding successes. */
export function worstStatus(checks: DiagnosticCheck[]): CheckStatus {
  const rank: Record<CheckStatus, number> = { ok: 0, unknown: 1, degraded: 2, failed: 3 };
  return checks.reduce<CheckStatus>(
    (worst, c) => (rank[c.status] > rank[worst] ? c.status : worst),
    "ok",
  );
}

/**
 * Clock skew against a trusted reference, in milliseconds.
 *
 * Matters because pair tokens carry a 180-second TTL: a device whose clock is
 * far enough off will have every pairing attempt rejected as expired, with no
 * indication that time is the cause.
 */
export const CLOCK_SKEW_WARN_MS = 60_000;

export function clockSkewCheck(localNow: number, referenceNow: number | null): DiagnosticCheck {
  if (referenceNow === null) {
    return {
      id: "clock",
      status: "unknown",
      summary: "No trusted time reference was available to compare against.",
      remediation: "NONE",
    };
  }
  const skewMs = localNow - referenceNow;
  const magnitude = Math.abs(skewMs);
  if (magnitude <= CLOCK_SKEW_WARN_MS) {
    return {
      id: "clock",
      status: "ok",
      summary: "System clock is within tolerance.",
      remediation: "NONE",
      detail: { skewMs },
    };
  }
  return {
    id: "clock",
    status: "degraded",
    summary:
      `System clock differs from the reference by ${Math.round(magnitude / 1000)}s. ` +
      "Pairing tokens expire after 180s, so a large skew can make every pairing attempt fail.",
    remediation: "CLOCK_SKEWED",
    detail: { skewMs },
  };
}

export function buildReport(checks: DiagnosticCheck[], now: Date = new Date()): DiagnosticsReport {
  return {
    contractVersion: DIAGNOSTICS_CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    overall: worstStatus(checks),
    checks,
  };
}

/**
 * Recursively strip anything secret-shaped from a value destined for the
 * report.
 *
 * Belt-and-braces: individual checks are written not to include secrets, but
 * this endpoint exists to be pasted into bug reports, so a single careless
 * check must not be able to leak a credential. Key-name matching is deliberately
 * broad — a false positive costs a redacted diagnostic, a false negative costs a
 * leaked key.
 */
const SECRET_KEY_RE = /(key|token|secret|password|passwd|credential|authorization|cookie)/i;

export function redactValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactValue(v);
    }
    return out as unknown as T;
  }
  return value;
}
