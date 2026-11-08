import { homedir } from "os";
import { join } from "path";

/**
 * Where Claude Code keeps its state: `$CLAUDE_CONFIG_DIR` when set, else
 * `~/.claude`. Every streamer site that reads or watches Claude's files goes
 * through here, so the dir a session is spawned into and the dir the streamer
 * watches cannot disagree.
 */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** The transcript root under {@link defaultClaudeConfigDir}. */
export function defaultClaudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultClaudeConfigDir(env), "projects");
}
