import { buildFlagArgs, type ClaudeFlagValues, withAdditionalDirs } from "../claude-flags";
import {
  CODEX_CLI_PROVIDER,
  COPILOT_PROVIDER,
  CURSOR_PROVIDER,
  coerceProviderForRunner,
} from "../providers";
import type { ManagedSession } from "../types";

export type HandoffSession = Pick<
  ManagedSession,
  "provider" | "projectPath" | "additionalPaths" | "model" | "effort"
>;

/**
 * The agent's own resume argv (executable excluded) for a person at a
 * terminal. Mirrors each runner's resume argv minus what exists only for the
 * streamer's PTY: Claude's `--settings` (streamer hooks), `--permission-mode`
 * (the person answers prompts) and the free-form extra args (which can re-add
 * either); Codex's `--no-alt-screen` (for the screen scraper).
 */
export function handoffArgv(
  session: HandoffSession,
  resumeId: string,
  claudeFlags: ClaudeFlagValues | undefined,
): string[] {
  const p = session.projectPath;
  switch (coerceProviderForRunner(session.provider)) {
    case CODEX_CLI_PROVIDER:
      return [
        "resume",
        resumeId,
        "--cd",
        p,
        ...(session.additionalPaths ?? []).flatMap((d) => ["--add-dir", d]),
      ];
    case CURSOR_PROVIDER:
      return ["--workspace", p, "--trust", `--resume=${resumeId}`];
    case COPILOT_PROVIDER:
      return [
        "-C",
        p,
        `--resume=${resumeId}`,
        ...(session.model ? ["--model", session.model] : []),
      ];
    default:
      return [
        "--resume",
        resumeId,
        ...(session.model ? ["--model", session.model] : []),
        ...(session.effort ? ["--effort", session.effort] : []),
        ...buildFlagArgs(withAdditionalDirs(claudeFlags, session.additionalPaths)),
      ];
  }
}
