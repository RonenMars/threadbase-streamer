import { execFile } from "child_process";

/**
 * The rendered screen of an external Codex process, when it runs in a tmux
 * pane. Read-only: `ps` for the pid's terminal, `tmux list-panes` to find the
 * pane on that terminal, `tmux capture-pane -p` to print it. Nothing is sent to
 * the pane and nothing attaches to it.
 *
 * Null when there is no evidence: Windows, no tmux, no tmux server, a process
 * outside tmux or with no terminal (`??` names no pane), two panes on one
 * terminal, or any command failing or timing out.
 */
export type RunCommand = (bin: string, args: string[], timeoutMs: number) => Promise<string>;

const TIMEOUT_MS = 1500;
/** The footer and anything above it worth reading (an approval card, the turn timer). */
const CAPTURE_LINES = 40;

export async function codexPaneScreen(
  pid: number,
  options: { run?: RunCommand; platform?: NodeJS.Platform } = {},
): Promise<string[] | null> {
  if ((options.platform ?? process.platform) === "win32") return null;
  const run = options.run ?? runCommand;
  try {
    const tty = (await run("ps", ["-o", "tty=", "-p", String(pid)], TIMEOUT_MS)).trim();
    const devTty = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    const panes = (
      await run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"], TIMEOUT_MS)
    )
      .split("\n")
      .map((l) => l.trim().split(" "))
      .filter(([paneTty, id]) => paneTty === devTty && id);
    if (panes.length !== 1) return null;
    const out = await run(
      "tmux",
      ["capture-pane", "-p", "-t", panes[0][1], "-S", `-${CAPTURE_LINES}`],
      TIMEOUT_MS,
    );
    return out.split("\n");
  } catch {
    return null;
  }
}

function runCommand(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}
