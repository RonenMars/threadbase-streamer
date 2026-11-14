import { execFile } from "child_process";
import { promisify } from "util";

export const HANDOFF_TMUX_SESSION = "threadbase";
export const HANDOFF_ATTACH_COMMAND = `tmux attach -t ${HANDOFF_TMUX_SESSION}`;

/**
 * Run `argv` in a new window of the `threadbase` tmux session, creating the
 * session detached when it is missing. argv goes to tmux directly, never
 * through a shell. Resolves with the pane id once the pane is still alive
 * after `settleMs`; rejects when tmux fails or the agent died at once.
 */
export async function openTmuxWindow(
  tmuxPath: string,
  opts: {
    name: string;
    cwd: string;
    argv: string[];
    env: Record<string, string>;
    settleMs: number;
  },
): Promise<string> {
  // promisify per call, not at import: tests that mock child_process without
  // execFile import this module through the sessions handlers.
  const exec = (args: string[]) => promisify(execFile)(tmuxPath, args, { env: opts.env });
  const exact = `=${HANDOFF_TMUX_SESSION}`;
  const exists = await exec(["has-session", "-t", exact]).then(
    () => true,
    () => false,
  );
  const place = exists
    ? ["new-window", "-P", "-F", "#{pane_id}", "-t", `${exact}:`]
    : ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", HANDOFF_TMUX_SESSION];
  const { stdout } = await exec([...place, "-n", opts.name, "-c", opts.cwd, "--", ...opts.argv]);
  const paneId = stdout.trim();

  // ponytail: settleMs catches an agent that dies at once (bad id, bad flag),
  // not one that fails later; a later failure shows in the tmux window itself.
  await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
  // Only "0" is alive: a gone pane prints nothing (exit 0) while the server
  // lives, remain-on-exit prints "1", and a server that died with it errors.
  const { stdout: dead } = await exec(["display-message", "-p", "-t", paneId, "#{pane_dead}"]);
  if (dead.trim() !== "0") throw new Error(`tmux pane ${paneId} exited`);
  return paneId;
}
