import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

export type PromptResult =
  | { choice: "replace-prod"; remember: boolean }
  | { choice: "use-port"; port: number; remember: boolean };

export type PromptFn = (opts: {
  prodPort: number;
  suggestedAltPort: number;
}) => Promise<PromptResult>;

export const interactivePrompt: PromptFn = async ({ prodPort, suggestedAltPort }) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      `\nProd streamer is running on port ${prodPort}.\n` +
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
