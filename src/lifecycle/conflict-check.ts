import { execFileSync } from "node:child_process";
import { LAUNCHD_LABEL } from "./constants";

/**
 * All known launchd labels this project has shipped (or might ship). The
 * conflict check scans for *loaded* labels OTHER than the one about to run.
 */
export const KNOWN_STREAMER_LABELS = [
  "com.ronen.threadbase",
  "homebrew.mxcl.tb-streamer",
  "com.threadbase.streamer",
] as const;

/** Legacy label pattern: `com.threadbase.streamer*` (e.g. `com.threadbase.streamer.1`). */
const LEGACY_PATTERN = /^com\.threadbase\.streamer/;

function uidScope(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/**
 * Resolves the launchd label THIS process will operate on (the same label
 * `resolveLoadedLabel` in `launchd.ts` returns). Duplicated here to avoid a
 * cyclic import; the canonical resolver lives in launchd.ts.
 */
function resolveOwnLabel(): string {
  if (process.env.LAUNCHD_LABEL) return process.env.LAUNCHD_LABEL;
  try {
    execFileSync("launchctl", ["print", `${uidScope()}/homebrew.mxcl.tb-streamer`], {
      stdio: "ignore",
    });
    return "homebrew.mxcl.tb-streamer";
  } catch {
    return LAUNCHD_LABEL;
  }
}

function isLabelLoaded(label: string): boolean {
  try {
    execFileSync("launchctl", ["list", label], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export type ConflictInfo = {
  label: string;
  resolution: "bootout" | "uninstall-homebrew";
};

/**
 * Scans for Threadbase streamer launchd agents OTHER than the one this
 * process will operate on. Returns an array of loaded conflicting labels
 * with a suggested resolution.
 *
 * On non-macOS platforms, returns an empty array (no launchd).
 */
export function detectConflictingAgents(): ConflictInfo[] {
  if (process.platform !== "darwin") return [];

  const ownLabel = resolveOwnLabel();
  const conflicts: ConflictInfo[] = [];

  for (const label of KNOWN_STREAMER_LABELS) {
    if (label === ownLabel) continue;
    if (isLabelLoaded(label)) {
      conflicts.push({
        label,
        resolution: label === "homebrew.mxcl.tb-streamer" ? "uninstall-homebrew" : "bootout",
      });
    }
  }

  // Scan for legacy variants (com.threadbase.streamer.N, etc.) via launchctl list
  try {
    const out = execFileSync("launchctl", ["list"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const label = parts[2];
      if (!label) continue;
      if (
        LEGACY_PATTERN.test(label) &&
        label !== ownLabel &&
        !conflicts.some((c) => c.label === label)
      ) {
        conflicts.push({ label, resolution: "bootout" });
      }
    }
  } catch {
    // launchctl list failed — can't scan for legacy
  }

  return conflicts;
}

/**
 * Formats a user-friendly message explaining the conflict and how to resolve it.
 */
export function formatConflictMessage(conflicts: ConflictInfo[]): string {
  if (conflicts.length === 0) return "";

  const lines = ["Conflicting Threadbase streamer agents detected:", ""];

  for (const c of conflicts) {
    if (c.resolution === "uninstall-homebrew") {
      lines.push(
        `  • ${c.label} — run: brew services stop tb-streamer && brew uninstall tb-streamer`,
      );
    } else {
      lines.push(`  • ${c.label} — run: launchctl bootout gui/$(id -u)/${c.label}`);
    }
  }

  lines.push(
    "",
    "Only one Threadbase streamer can bind port 8766. Remove the conflicting agent(s) to proceed.",
  );

  return lines.join("\n");
}
