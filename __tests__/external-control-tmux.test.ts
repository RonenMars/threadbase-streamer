import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type ResolverDeps, resolveBinding } from "../src/services/external-control/resolver";
import { createTmuxExec, hexKeyArgs, type TmuxExec } from "../src/tmux/client";
import { listPanes } from "../src/tmux/pane-inventory";
import { processStartToken, readProcessTable, verifyForeground } from "../src/tmux/process-table";
import { capturePane } from "../src/tmux/screen";
import { checkSocket, identifyServer } from "../src/tmux/server-registry";
import type { DiscoveredProcess } from "../src/types";

/**
 * Phase 0/1 of Connect live against a real tmux server on an isolated socket:
 * pane identity, foreground ownership, the command-parser hazard, and
 * byte-exact literal delivery. Never touches the user's default server.
 */

function findTmux(): string | null {
  try {
    return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const TMUX = process.platform === "win32" ? null : findTmux();

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    v = await fn();
  }
  return v;
}

describe.skipIf(!TMUX)("external control on a real tmux server", () => {
  let dir: string;
  let sock: string;
  let exec: TmuxExec;
  const raw = (...args: string[]) =>
    execFileSync(TMUX as string, ["-S", sock, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: { ...process.env, TMUX: "" },
    });

  /** A pane whose foreground program records every byte it reads. */
  function recorderPane(name: string): { paneId: `%${number}`; file: string } {
    const file = join(dir, `${name}.rec`);
    const cmd = `stty raw -echo; exec cat > '${file}'`;
    const out = raw("new-window", "-d", "-P", "-F", "#{pane_id}", "-n", name, "sh", "-c", cmd);
    return { paneId: out.trim() as `%${number}`, file };
  }

  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };

  const panePid = (paneId: string) =>
    Number(raw("display-message", "-p", "-t", paneId, "#{pane_pid}").trim());

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-extctl-"));
    chmodSync(dir, 0o700);
    sock = join(dir, "s");
    raw("new-session", "-d", "-s", "main", "-x", "100", "-y", "20", "sleep", "600");
    exec = createTmuxExec(TMUX as string);
  });

  afterAll(() => {
    try {
      raw("kill-server");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("trusts its own 0700 socket and refuses a symlink or an open directory", () => {
    expect(checkSocket(sock).ok).toBe(true);
    const link = join(dir, "link");
    symlinkSync(sock, link);
    expect(checkSocket(link).reason).toBe("symlink");
    const open = join(dir, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const openSock = join(open, "s");
    execFileSync(TMUX as string, [
      "-S",
      openSock,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "sleep",
      "5",
    ]);
    try {
      expect(checkSocket(openSock).reason).toBe("unsafe_dir");
    } finally {
      execFileSync(TMUX as string, ["-S", openSock, "kill-server"]);
    }
    expect(checkSocket("relative/sock").reason).toBe("not_absolute");
  });

  it("never starts a server on a socket with none behind it", async () => {
    const ghost = join(dir, "ghost");
    await expect(exec(ghost, ["list-panes", "-a"])).rejects.toMatchObject({});
    expect(checkSocket(ghost).reason).toBe("missing");
  });

  // The finding that shapes the input design: argv does not bypass tmux's own
  // command parser. A trailing `;` is a separator, so `-l` silently drops it.
  it("loses a trailing semicolon through send-keys -l, which is why input goes hex", async () => {
    const { paneId, file } = recorderPane("parser");
    await waitFor(
      () => panePid(paneId),
      (p) => p > 0,
    );
    await new Promise((r) => setTimeout(r, 200));
    raw("send-keys", "-l", "-t", paneId, "--", "a;");
    raw("send-keys", "-l", "-t", paneId, "--", ";");
    raw("send-keys", "-l", "-t", paneId, "--", "z");
    expect(
      await waitFor(
        () => read(file),
        (s) => s.includes("z"),
      ),
    ).toBe("az");
  });

  it("types hostile literals byte for byte, and only into the target pane", async () => {
    const target = recorderPane("target");
    const bystander = recorderPane("bystander");
    await new Promise((r) => setTimeout(r, 300));
    const corpus = [
      "a;",
      ";",
      "b\\;",
      "-x",
      "--",
      "#{pane_id}",
      '"q"',
      "x'y",
      "$HOME",
      "é✓ 🙂",
      "{ } %if",
      "c ; kill-server",
    ];
    for (const text of corpus) await exec(sock, hexKeyArgs(target.paneId, text));
    const expected = corpus.join("");
    expect(
      await waitFor(
        () => read(target.file),
        (s) => s.length >= expected.length,
      ),
    ).toBe(expected);
    expect(read(bystander.file)).toBe("");
    // kill-server was text, not a command: the server is still here.
    expect(raw("display-message", "-p", "#{pid}").trim()).toMatch(/^\d+$/);
  });

  it("lists each pane once even when its window is linked into two sessions", async () => {
    const { paneId } = recorderPane("linked");
    raw("new-session", "-d", "-s", "other", "sleep", "600");
    raw("link-window", "-s", `main:linked`, "-t", "other:");
    const panes = await listPanes(exec, sock);
    expect(panes.filter((p) => p.paneId === paneId)).toHaveLength(1);
  });

  it("proves foreground ownership and rejects a background job", async () => {
    const { paneId } = recorderPane("fg");
    const pid = await waitFor(
      () => panePid(paneId),
      (p) => p > 0,
    );
    const pane = (await listPanes(exec, sock)).find((p) => p.paneId === paneId);
    expect(pane).toBeDefined();
    const table = await readProcessTable();
    expect(verifyForeground(table, pid, pane as NonNullable<typeof pane>)).toEqual({ ok: true });

    const shell = raw(
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-n",
      "bg",
      "bash",
      "--norc",
      "--noprofile",
      "-i",
    ).trim();
    await new Promise((r) => setTimeout(r, 300));
    raw("send-keys", "-t", shell, "sleep 300 &", "Enter");
    const shellPid = panePid(shell);
    const sleeper = await waitFor(
      async () => [...(await readProcessTable()).values()].find((r) => r.ppid === shellPid),
      (r) => r !== undefined,
    );
    expect(sleeper).toBeDefined();
    const shellPane = (await listPanes(exec, sock)).find((p) => p.paneId === shell);
    const t2 = await readProcessTable();
    expect(
      verifyForeground(t2, sleeper?.pid as number, shellPane as NonNullable<typeof shellPane>),
    ).toEqual({ ok: false, reason: "background" });
    // The recorder is on a different tty from the shell pane.
    expect(verifyForeground(t2, pid, shellPane as NonNullable<typeof shellPane>)).toEqual({
      ok: false,
      reason: "tty_mismatch",
    });
  });

  it("binds a discovered process to its exact pane and reads its screen", async () => {
    const shown = raw(
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-n",
      "agent",
      "sh",
      "-c",
      "printf 'agent ready\\n'; exec sleep 600",
    ).trim() as `%${number}`;
    const pid = await waitFor(
      () => panePid(shown),
      (p) => p > 0,
    );
    const proc: DiscoveredProcess = {
      pid,
      provider: "claude-code",
      projectPath: dir,
      projectName: "x",
      branch: "",
      conversationId: "conv-1",
      startedAt: new Date(),
    };
    const deps: ResolverDeps = {
      exec,
      sockets: [sock],
      bootId: async () => "boot",
      processTable: readProcessTable,
      startToken: processStartToken,
      currentConversation: async () => "conv-1",
      otherAgentPids: () => [],
      env: { TMUX_TMPDIR: join(dir, "none") },
    };
    const bound = await resolveBinding(proc, "conv-1", deps);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.binding.pane.paneId).toBe(shown);
    expect(bound.binding.agentPid).toBe(pid);

    const screen = await waitFor(
      () => capturePane(exec, sock, shown),
      (s) => s.lines.some((l) => l.includes("agent ready")),
    );
    expect(screen.cols).toBeGreaterThan(0);
    expect(screen.screenRevision).toMatch(/^sc_[0-9a-f]{16}$/);

    // The same process, asked again: same binding. A conversation switch: none.
    const again = await resolveBinding(proc, "conv-1", deps);
    expect(again.ok && again.binding.bindingId).toBe(bound.binding.bindingId);
    expect(
      await resolveBinding(proc, "conv-1", { ...deps, currentConversation: async () => "conv-2" }),
    ).toEqual({ ok: false, reason: "CONVERSATION_CHANGED" });

    // The agent dies: never re-bound to whatever is left.
    raw("kill-pane", "-t", shown);
    const gone = await waitFor(
      () => resolveBinding(proc, "conv-1", deps),
      (r) => !r.ok,
    );
    expect(gone.ok).toBe(false);
  });

  it("gives a restarted server on the same socket a new generation", async () => {
    const before = await identifyServer(exec, sock, checkSocket(sock), "boot");
    const alt = join(dir, "restart");
    const start = () =>
      execFileSync(TMUX as string, [
        "-S",
        alt,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "sleep",
        "60",
      ]);
    start();
    const g1 = await identifyServer(exec, alt, checkSocket(alt), "boot");
    execFileSync(TMUX as string, ["-S", alt, "kill-server"]);
    await new Promise((r) => setTimeout(r, 100));
    start();
    const g2 = await identifyServer(exec, alt, checkSocket(alt), "boot");
    execFileSync(TMUX as string, ["-S", alt, "kill-server"]);
    expect(before?.serverRef).toMatch(/^tmx_[0-9a-f]{12}$/);
    expect(g1?.serverRef).toBe(g2?.serverRef);
    expect(g1?.generation).not.toBe(g2?.generation);
  });
});
