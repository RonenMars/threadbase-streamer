import { execFileSync } from "node:child_process";
import { LAUNCHD_LABEL } from "./constants";

function uidScope(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function fullTarget(): string {
  return `${uidScope()}/${LAUNCHD_LABEL}`;
}

export function isAgentLoaded(): boolean {
  try {
    execFileSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function bootoutAgent(): void {
  try {
    execFileSync("launchctl", ["bootout", fullTarget()], { stdio: "ignore" });
  } catch {
    // already unloaded — fine
  }
}

export function bootstrapAgent(plistPath: string): void {
  execFileSync("launchctl", ["bootstrap", uidScope(), plistPath], { stdio: "ignore" });
}

export function kickstartAgent(): void {
  execFileSync("launchctl", ["kickstart", "-k", fullTarget()], { stdio: "ignore" });
}

/** Returns the current PID of the supervised agent, or null. */
export function getAgentPid(): number | null {
  try {
    const out = execFileSync("launchctl", ["list"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[2] === LAUNCHD_LABEL) {
        const pid = Number.parseInt(parts[0] ?? "", 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
