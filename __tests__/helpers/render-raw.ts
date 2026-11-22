import { Terminal } from "@xterm/headless";

/**
 * Render a raw PTY byte stream (as captured from a real CLI) into the screen
 * lines `getOutputLines` would return. Fixtures are raw bytes on purpose: a
 * printed or blank-stripped view hides exactly the layout a detector has to
 * survive.
 */
export async function renderRaw(raw: string, cols = 120, rows = 40): Promise<string[]> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(raw, resolve));
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? "");
  }
  term.dispose();
  return lines;
}
