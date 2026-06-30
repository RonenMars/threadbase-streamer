import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { THREADBASE_ROOT } from "./paths";

const LOG_PATH = join(THREADBASE_ROOT, "update.log");

export function appendUpdateLog(line: string): void {
  try {
    mkdirSync(THREADBASE_ROOT, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // Non-fatal — never let a logging failure break the update flow.
  }
}
