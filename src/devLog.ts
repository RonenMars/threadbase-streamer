import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { installDir } from "./lifecycle/constants";

export function devLogPath(): string {
  return join(installDir(), "logs", "dev.log");
}

// ponytail: append-only, never truncated — dev sessions stack up in one
// file instead of overwriting each other like prod's stdout/stderr do.
export function appendDevSessionMarker(): void {
  try {
    const path = devLogPath();
    mkdirSync(join(installDir(), "logs"), { recursive: true });
    appendFileSync(path, `=== dev session started ${new Date().toISOString()} ===\n`, "utf8");
  } catch {
    // Non-fatal — never let a logging failure block server startup.
  }
}
