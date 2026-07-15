// Persisted answers for Codex's blocking startup gates (directory trust,
// hooks review). When mobile answers a gate card with a "remember for all
// projects" option, the choice lands here and future gates are auto-answered
// without a card. One tiny JSON file; read at gate time so edits (or tests
// via THREADBASE_CONFIG_DIR) apply without a restart.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type CodexGateType = "hooks" | "trust";

export interface GateAnswers {
  codexHooksGate?: "trust_all" | "continue_untrusted";
  codexTrustGate?: "yes";
}

function gateAnswersPath(): string {
  const dir = process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase");
  return join(dir, "gate-answers.json");
}

export function loadGateAnswers(): GateAnswers {
  try {
    const parsed = JSON.parse(readFileSync(gateAnswersPath(), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as GateAnswers) : {};
  } catch {
    return {};
  }
}

export function saveGateAnswer<K extends keyof GateAnswers>(key: K, value: GateAnswers[K]): void {
  const path = gateAnswersPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...loadGateAnswers(), [key]: value }, null, 2)}\n`);
}

/**
 * The digit that answers a gate per the remembered choice, or null when the
 * user must be asked. Digits are the dialogs' literal on-screen numbers
 * (probe-verified: a digit keypress selects AND confirms, no Enter needed).
 */
export function rememberedGateDigit(gate: CodexGateType): string | null {
  const answers = loadGateAnswers();
  if (gate === "hooks") {
    if (answers.codexHooksGate === "trust_all") return "2";
    if (answers.codexHooksGate === "continue_untrusted") return "3";
    return null;
  }
  return answers.codexTrustGate === "yes" ? "1" : null;
}
