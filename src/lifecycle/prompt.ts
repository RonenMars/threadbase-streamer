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
