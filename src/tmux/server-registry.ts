import { execFile } from "child_process";
import { createHash } from "crypto";
import { lstatSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import type { TmuxExec } from "./client";

/**
 * The tmux servers external control may talk to: the current user's default
 * socket plus sockets the user registered locally. Never a path from a remote
 * request, and never a sweep of the filesystem for sockets.
 */

export interface TmuxServer {
  /** Opaque, stable for the socket path; what crosses the API instead of the path. */
  serverRef: string;
  socketPath: string;
  /** Changes whenever the server behind the socket is a different one. */
  generation: string;
  serverPid: number;
}

export type SocketRejection =
  | "missing"
  | "not_socket"
  | "symlink"
  | "foreign_owner"
  | "unsafe_dir"
  | "not_absolute";

export interface SocketCheck {
  ok: boolean;
  reason?: SocketRejection;
  realPath?: string;
  devIno?: string;
}

/** tmux's own default: `$TMUX_TMPDIR` or `/tmp`, then `tmux-<uid>/default`. */
export function defaultSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  uid: number = process.getuid?.() ?? -1,
): string {
  return join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, "default");
}

/**
 * A socket is trusted when it, and the directory holding it, belong to this
 * user and nobody else can reach them. tmux creates its socket directory 0700;
 * a group- or world-accessible one is not tmux's and is refused.
 */
export function checkSocket(
  socketPath: string,
  uid: number = process.getuid?.() ?? -1,
  stat: typeof lstatSync = lstatSync,
): SocketCheck {
  if (!isAbsolute(socketPath)) return { ok: false, reason: "not_absolute" };
  let st: ReturnType<typeof lstatSync>;
  try {
    st = stat(socketPath);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!st) return { ok: false, reason: "missing" };
  if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!st.isSocket()) return { ok: false, reason: "not_socket" };
  if (st.uid !== uid) return { ok: false, reason: "foreign_owner" };
  let dir: ReturnType<typeof lstatSync>;
  try {
    dir = stat(dirname(socketPath));
  } catch {
    return { ok: false, reason: "unsafe_dir" };
  }
  if (!dir || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o077) !== 0) {
    return { ok: false, reason: "unsafe_dir" };
  }
  let realPath = socketPath;
  try {
    realPath = realpathSync(socketPath);
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, realPath, devIno: `${st.dev}:${st.ino}` };
}

export function serverRefFor(realSocketPath: string): string {
  return `tmx_${createHash("sha256").update(realSocketPath).digest("hex").slice(0, 12)}`;
}

let bootIdCache: Promise<string> | null = null;

/** Linux boot_id, or macOS kern.boottime; "" when neither is readable. */
export function bootIdentity(): Promise<string> {
  bootIdCache ??= new Promise((resolve) => {
    try {
      resolve(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
      return;
    } catch {}
    execFile("sysctl", ["-n", "kern.boottime"], { timeout: 1_000 }, (err, out) =>
      resolve(err ? "" : String(out).trim()),
    );
  });
  return bootIdCache;
}

/**
 * Identify the server behind a trusted socket. The generation folds in the
 * boot, the server's pid and start time, and the socket's inode, so a server
 * restarted on the same path — or a reused pid after a reboot — is a new one.
 */
export async function identifyServer(
  exec: TmuxExec,
  socketPath: string,
  check: SocketCheck,
  bootId: string,
): Promise<TmuxServer | null> {
  if (!check.ok || !check.realPath) return null;
  const out = (await exec(socketPath, ["display-message", "-p", "#{pid}|#{start_time}"])).trim();
  const m = /^(\d+)\|(\d+)$/.exec(out);
  if (!m) return null;
  const serverPid = Number(m[1]);
  const generation = createHash("sha256")
    .update([bootId, m[1], m[2], check.devIno ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);
  return {
    serverRef: serverRefFor(check.realPath),
    socketPath: check.realPath,
    generation,
    serverPid,
  };
}
