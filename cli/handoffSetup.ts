import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { handoffConfigPath, readHandoffConfig, writeHandoffConfig } from "../src/handoff/config";
import { HANDOFF_ATTACH_COMMAND } from "../src/handoff/tmux";
import { locateExecutable } from "../src/platform";

export interface HandoffSetupDeps {
  log: { info: (msg: string) => void; error: (msg: string) => void };
  ask?: (question: string) => Promise<string>;
  platform?: NodeJS.Platform;
  locate?: (exe: string) => string | null;
}

async function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * `tb-streamer handoff setup`: turn "Hand off to Terminal" on or off.
 * Re-runnable; the streamer reads the result per request, so no restart.
 */
export async function runHandoffSetup(deps: HandoffSetupDeps): Promise<number> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    deps.log.error("Hand off to Terminal is macOS-only for now.");
    return 1;
  }
  // Resolved from this shell's PATH: the launchd streamer's PATH lacks Homebrew.
  const tmuxPath = (deps.locate ?? locateExecutable)("tmux");
  if (!tmuxPath) {
    deps.log.error("tmux not found on PATH. Install it with: brew install tmux");
    return 1;
  }

  const enabledNow = readHandoffConfig(platform) !== null;
  const ask = deps.ask ?? defaultAsk;
  deps.log.info(
    `Hand off to Terminal moves a session from the app into tmux on this Mac.\n` +
      `  1) Enable\n  2) Disable`,
  );
  const answer = (await ask(`Choice [${enabledNow ? 1 : 2}]: `)).trim();
  const enabled = answer === "" ? enabledNow : answer === "1";
  if (answer !== "" && answer !== "1" && answer !== "2") {
    deps.log.error(`Unknown choice "${answer}"; nothing changed.`);
    return 1;
  }

  writeHandoffConfig({ enabled, tmuxPath });
  deps.log.info(
    enabled
      ? `Enabled (tmux: ${tmuxPath}). Wrote ${handoffConfigPath()}.\nAttach to handed-off sessions with: ${HANDOFF_ATTACH_COMMAND}`
      : `Disabled. Wrote ${handoffConfigPath()}.`,
  );
  return 0;
}
