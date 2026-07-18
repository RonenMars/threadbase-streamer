// Persisted cache-integrity alert state. Mirrors codexGateAnswers.ts: one small
// JSON file at ~/.threadbase/cache-alert.json (respecting THREADBASE_CONFIG_DIR),
// read/written so a pending alert survives a restart and re-surfaces on every
// client connect, and so an "ignore" decision is durable across restarts.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** One missing conversation the alert covers. */
export interface MissingEntry {
  id: string;
  filePath: string;
  title: string | null;
  tailed: boolean;
}

export interface PendingAlert {
  fingerprint: string;
  severity: "high" | "low";
  detectedAt: string;
  missingCount: number;
  totalRows: number;
  backupPath?: string;
  /** Capped at 1000 entries in the persisted file. */
  missing: MissingEntry[];
}

export interface AlertState {
  pending?: PendingAlert;
  ignoredIds?: string[];
}

function alertStatePath(): string {
  const dir = process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase");
  return join(dir, "cache-alert.json");
}

export function loadAlertState(): AlertState {
  try {
    const parsed = JSON.parse(readFileSync(alertStatePath(), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as AlertState) : {};
  } catch {
    return {};
  }
}

export function saveAlertState(state: AlertState): void {
  const path = alertStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
