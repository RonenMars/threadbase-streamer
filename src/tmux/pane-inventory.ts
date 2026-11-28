import { isPaneId, type TmuxExec } from "./client";

export interface PaneRecord {
  paneId: `%${number}`;
  panePid: number;
  /** Without the `/dev/` prefix, to compare with `ps -o tty=`. */
  paneTty: string;
  dead: boolean;
  inMode: boolean;
}

/**
 * Only numeric fields and the tty path, which tmux derives from the kernel.
 * Display names (session, window, title, current command) are user- or
 * program-controlled and may carry the separator, so they are not identity and
 * are not read at all.
 */
const PANE_FORMAT = "#{pane_id}|#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_in_mode}";

const TTY = /^\/dev\/([A-Za-z0-9._/-]{1,64})$/;

export function parsePaneList(stdout: string): PaneRecord[] {
  const byId = new Map<string, PaneRecord>();
  for (const line of stdout.split("\n")) {
    const parts = line.split("|");
    if (parts.length !== 5) continue;
    const [paneId, pid, tty, dead, mode] = parts;
    const ttyMatch = TTY.exec(tty);
    if (!isPaneId(paneId) || !/^\d+$/.test(pid) || !ttyMatch) continue;
    // A window linked into several sessions lists its panes once per link.
    byId.set(paneId, {
      paneId,
      panePid: Number(pid),
      paneTty: ttyMatch[1],
      dead: dead === "1",
      inMode: mode === "1",
    });
  }
  return [...byId.values()];
}

export async function listPanes(exec: TmuxExec, socketPath: string): Promise<PaneRecord[]> {
  return parsePaneList(await exec(socketPath, ["list-panes", "-a", "-F", PANE_FORMAT]));
}
