import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

export type PromptResult =
  | { choice: "replace-prod"; remember: boolean }
  | { choice: "use-port"; port: number; remember: boolean };

export type PromptFn = (opts: {
  prodPort: number;
  suggestedAltPort: number;
  prodActive: boolean;
  portTaken: boolean;
}) => Promise<PromptResult>;

export const interactivePrompt: PromptFn = async ({ prodPort, suggestedAltPort, prodActive }) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    // portTaken is always true here — resolveDevPlan only reaches this prompt
    // when the requested port is actually held. prodActive distinguishes
    // whether the supervised prod streamer is the one holding it — bootout
    // (the "r" option) only helps in that case, so an unrelated process
    // holding the port skips straight to the alt-port question.
    if (!prodActive) {
      stdout.write(
        `\nPort ${prodPort} is already in use by another process.\n` +
          `Running dev on port ${suggestedAltPort} instead.\n`,
      );
      const rememberAns = (await rl.question("Remember this choice for this repo? [y/N]: "))
        .trim()
        .toLowerCase();
      return {
        choice: "use-port",
        port: suggestedAltPort,
        remember: rememberAns === "y" || rememberAns === "yes",
      };
    }

    stdout.write(
      `\nThe supervised prod streamer is already holding port ${prodPort}.\n` +
        `  [r] Stop prod and take port ${prodPort}\n` +
        `  [p] Run dev on port ${suggestedAltPort} instead\n`,
    );
    const choiceAns = (await rl.question("Choice [r/p]: ")).trim().toLowerCase();
    const rememberAns = (await rl.question("Remember this choice for this repo? [y/N]: "))
      .trim()
      .toLowerCase();
    const remember = rememberAns === "y" || rememberAns === "yes";

    if (choiceAns === "r") {
      return { choice: "replace-prod", remember };
    }
    return { choice: "use-port", port: suggestedAltPort, remember };
  } finally {
    rl.close();
  }
};

export type PermissionModePromptFn = () => Promise<"acceptEdits" | "manual">;

export const interactivePermissionModePrompt: PermissionModePromptFn = async () => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      "\nWhich permission mode should spawned Claude Code sessions use?\n" +
        "  [a] acceptEdits — auto-approve file edits, still prompt for shell commands (default)\n" +
        "  [m] manual — prompt for every edit and command\n",
    );
    const ans = (await rl.question("Choice [a/m] (default a): ")).trim().toLowerCase();
    return ans === "m" ? "manual" : "acceptEdits";
  } finally {
    rl.close();
  }
};

export type AutoResumePromptFn = () => Promise<boolean>;

/**
 * The one-time question behind auto-resume on boot (plan Phase 7b).
 *
 * Asked at most once per machine: both answers are persisted, so the next boot
 * finds the key present and stays quiet. Defaults to **no** on an empty line,
 * because this is the one setting that lets the streamer start an agent nobody
 * asked for in that moment — and with a bypass permission mode that is
 * unattended arbitrary code execution. Silence must never enable it.
 */
export const interactiveAutoResumePrompt: AutoResumePromptFn = async () => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      "\nResume interrupted sessions automatically when the streamer starts?\n" +
        "  [n] No — show them in the list and let me tap to resume (default)\n" +
        "  [y] Yes — re-attach them automatically on boot\n\n" +
        "Note: yes means agents can start without you present, including after a reboot.\n",
    );
    const ans = (await rl.question("Choice [y/N]: ")).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
};

/** What the relay is and what it can see; shared by the prompts and `relay enable`. */
export function relayExplanation(endpoint: string): string {
  return (
    `  The relay is a server run by Threadbase at ${endpoint}.\n` +
    "  This streamer keeps an outbound connection open to it, so a paired phone can reach\n" +
    "  you from any network without a tunnel of your own.\n\n" +
    "  It cannot read your sessions or files: traffic is end-to-end encrypted between the\n" +
    "  phone and this streamer. It does see that you are connected: your IP address, the\n" +
    "  paths requested, sizes and timing.\n\n" +
    "  Without it, the phone reaches you only on your own network or through a tunnel you set up.\n" +
    "  Change your mind any time with `tb-streamer relay disable`.\n"
  );
}

export type RelayPromptFn = (endpoint: string) => Promise<boolean>;

/** First run: nothing has said anything about the relay. Empty line means no. */
export const interactiveRelayPrompt: RelayPromptFn = async (endpoint) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      `\nUse the Threadbase relay for access from outside your network?\n${relayExplanation(endpoint)}\n`,
    );
    const ans = (await rl.question("Use the relay? [y/N]: ")).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
};

export type RelayConfirmFn = (endpoint: string, source: string) => Promise<boolean>;

/** The relay was switched on by something other than this prompt. Empty line means without. */
export const interactiveRelayConfirm: RelayConfirmFn = async (endpoint, source) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const bar = "!".repeat(72);
    stdout.write(
      `\n${bar}\n` +
        "!!  THE THREADBASE RELAY IS TURNED ON\n" +
        `!!  It was enabled by: ${source}. You have not confirmed it.\n` +
        `${bar}\n\n${relayExplanation(endpoint)}\n` +
        '  Choosing "without" turns it off in server.yaml and starts without it.\n\n',
    );
    const ans = (await rl.question("Start [w]ith the relay or [W]ithout it? [w/W]: ")).trim();
    return ans === "w";
  } finally {
    rl.close();
  }
};
