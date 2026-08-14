import type { ManagedSessionRow } from "../../db/repositories/managed-sessions.repository";
import { resumeIdForRow } from "./resumeIdentity";

/** Only a recent restart is eligible for unattended recovery. */
export const AUTO_RESUME_WINDOW_MS = 15 * 60 * 1000;

/** Hard ceiling for unattended agent starts during one boot. */
export const AUTO_RESUME_MAX = 5;

/** At most two provider processes may be starting at once. */
export const AUTO_RESUME_CONCURRENCY = 2;

/** Keep successive starts from landing on the host in the same instant. */
export const AUTO_RESUME_STAGGER_MS = 500;

export type AutoResumeSkipReason =
  | "not_shutdown"
  | "not_interrupted"
  | "too_old"
  | "project_missing"
  | "resume_identity_missing"
  | "history_missing";

export interface AutoResumeOptions {
  now: number;
  projectExists: (projectPath: string) => boolean;
  historyExists: (row: ManagedSessionRow) => boolean;
}

/** Why a persisted row must remain a user-driven resume, or null when eligible. */
export function autoResumeSkipReason(
  row: ManagedSessionRow,
  opts: AutoResumeOptions,
): AutoResumeSkipReason | null {
  if (row.status_source !== "shutdown") return "not_shutdown";
  if (row.status !== "running" && row.status !== "waiting_input") return "not_interrupted";
  if (opts.now - row.status_updated_at > AUTO_RESUME_WINDOW_MS) return "too_old";
  if (!opts.projectExists(row.project_path)) return "project_missing";
  if (resumeIdForRow(row) == null) return "resume_identity_missing";
  if (!opts.historyExists(row)) return "history_missing";
  return null;
}

export interface AutoResumePlan {
  attempts: ManagedSessionRow[];
  skipped: Array<{ row: ManagedSessionRow; reason: AutoResumeSkipReason }>;
  overflow: ManagedSessionRow[];
}

/** Preserve repository order while applying eligibility and the per-boot ceiling. */
export function planAutoResume(rows: ManagedSessionRow[], opts: AutoResumeOptions): AutoResumePlan {
  const eligible: ManagedSessionRow[] = [];
  const skipped: AutoResumePlan["skipped"] = [];

  for (const row of rows) {
    const reason = autoResumeSkipReason(row, opts);
    if (reason) skipped.push({ row, reason });
    else eligible.push(row);
  }

  return {
    attempts: eligible.slice(0, AUTO_RESUME_MAX),
    skipped,
    overflow: eligible.slice(AUTO_RESUME_MAX),
  };
}
