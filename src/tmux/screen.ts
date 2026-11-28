import { createHash } from "crypto";
import type { TmuxExec } from "./client";

export const SCREEN_HISTORY_LINES = 200;
export const SCREEN_MAX_BYTES = 256 * 1024;

export interface PaneScreen {
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  /** Visible rows last; history above them, oldest first. */
  lines: string[];
  /** Content hash: the same screen reads as the same revision. */
  screenRevision: string;
  capturedAt: string;
  truncated: boolean;
}

/**
 * capture-pane without `-e` emits text, no SGR, but a program can still leave
 * raw control bytes (OSC 52 clipboard writes, hyperlinks, device queries) in
 * cells. Strip every C0/C1 control except tab, so a client rendering the text
 * can never be made to act on it.
 */
export function sanitizeScreenLine(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return line.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, "");
}

export function boundLines(
  lines: string[],
  maxBytes: number = SCREEN_MAX_BYTES,
): { lines: string[]; truncated: boolean } {
  let total = 0;
  const kept: string[] = [];
  // Keep the newest rows: the visible screen is at the bottom.
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i], "utf8") + 1;
    if (total + size > maxBytes) return { lines: kept.reverse(), truncated: true };
    total += size;
    kept.push(lines[i]);
  }
  return { lines: kept.reverse(), truncated: false };
}

export async function capturePane(
  exec: TmuxExec,
  socketPath: string,
  paneId: `%${number}`,
  now: () => Date = () => new Date(),
): Promise<PaneScreen> {
  const meta = (
    await exec(socketPath, [
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}",
    ])
  ).trim();
  const m = /^(\d+)\|(\d+)\|(\d+)\|(\d+)$/.exec(meta);
  if (!m) throw new Error("unexpected pane metadata");
  const raw = await exec(socketPath, [
    "capture-pane",
    "-p",
    "-t",
    paneId,
    "-S",
    `-${SCREEN_HISTORY_LINES}`,
  ]);
  const all = raw.replace(/\n$/, "").split("\n").map(sanitizeScreenLine);
  const { lines, truncated } = boundLines(all);
  return {
    cols: Number(m[1]),
    rows: Number(m[2]),
    cursor: { x: Number(m[3]), y: Number(m[4]) },
    lines,
    screenRevision: `sc_${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16)}`,
    capturedAt: now().toISOString(),
    truncated,
  };
}
