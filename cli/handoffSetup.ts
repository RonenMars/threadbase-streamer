import { existsSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  type HandoffTerminal,
  handoffConfigPath,
  readHandoffConfig,
  writeHandoffConfig,
} from "../src/handoff/config";
import { TERMINAL_APPS } from "../src/handoff/terminal";
import { HANDOFF_ATTACH_COMMAND } from "../src/handoff/tmux";
import { locateExecutable } from "../src/platform";

export interface HandoffSetupDeps {
  log: { info: (msg: string) => void; error: (msg: string) => void };
  ask?: (question: string) => Promise<string>;
  platform?: NodeJS.Platform;
  locate?: (exe: string) => string | null;
  appExists?: (appPath: string) => boolean;
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
 * `tb-streamer handoff setup`: turn "Hand off to Terminal" on or off, and
 * pick the terminal app a handoff may open.
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

  const current = readHandoffConfig(platform);
  const appExists = deps.appExists ?? existsSync;
  const options: { label: string; enabled: boolean; terminal: HandoffTerminal }[] = [
    ...(Object.keys(TERMINAL_APPS) as (keyof typeof TERMINAL_APPS)[])
      .filter((t) => appExists(TERMINAL_APPS[t].appPath))
      .map((t) => ({ label: TERMINAL_APPS[t].name, enabled: true, terminal: t })),
    { label: "Don't open a terminal (tmux only)", enabled: true, terminal: "none" },
    { label: "Disable handoff", enabled: false, terminal: "none" },
  ];
  const found = options.findIndex((o) => o.enabled && o.terminal === current?.terminal);
  // A configured app that is no longer on disk falls back to tmux only.
  const defaultIndex = !current ? options.length - 1 : found === -1 ? options.length - 2 : found;
  const ask = deps.ask ?? defaultAsk;
  deps.log.info(
    `Hand off to Terminal moves a session from the app into tmux on this Mac.\n` +
      `Which terminal app should a handoff open, when you ask it to from the app?\n` +
      options.map((o, i) => `  ${i + 1}) ${o.label}`).join("\n"),
  );
  const answer = (await ask(`Choice [${defaultIndex + 1}]: `)).trim();
  const chosen = answer === "" ? options[defaultIndex] : options[Number(answer) - 1];
  if (!chosen || (answer !== "" && !/^\d+$/.test(answer))) {
    deps.log.error(`Unknown choice "${answer}"; nothing changed.`);
    return 1;
  }
  const { enabled, terminal } = chosen;

  writeHandoffConfig({ enabled, tmuxPath, terminal });
  deps.log.info(
    enabled
      ? `Enabled (tmux: ${tmuxPath}, terminal: ${terminal}). Wrote ${handoffConfigPath()}.\nAttach to handed-off sessions with: ${HANDOFF_ATTACH_COMMAND}`
      : `Disabled. Wrote ${handoffConfigPath()}.`,
  );
  return 0;
}
