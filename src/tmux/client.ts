import { execFile } from "child_process";

/**
 * The one way the streamer talks to a tmux server it did not start.
 *
 * Every call names its server with `-S <socket>` (never the ambient `$TMUX`)
 * and passes `-N`, so a query against a socket whose server has gone cannot
 * start a new one. argv goes to tmux directly, never through a shell.
 *
 * tmux still has a command parser of its own, and argv does not bypass it: an
 * argument ending in `;` is read as a command separator, so `send-keys -l 'a;'`
 * delivers `a` and drops the rest (measured on tmux 3.4, see
 * docs/architecture/2026-11-28-external-agent-control.md). Callers therefore
 * never put caller-supplied text in argv; `hexKeyArgs` is the byte-exact path.
 */

export const TMUX_TIMEOUT_MS = 2_000;
/** A capture of 200 history lines at a wide pane fits well inside this. */
const TMUX_MAX_BUFFER = 1024 * 1024;

/** First release with `-N`; the spec's proposed 3.3a floor is a review item. */
export const TMUX_MIN_VERSION = { major: 3, minor: 2 } as const;

export class TmuxError extends Error {
  constructor(
    message: string,
    readonly code: "TMUX_TIMEOUT" | "TMUX_NO_SERVER" | "TMUX_FAILED",
  ) {
    super(message);
  }
}

export type TmuxExec = (socketPath: string, args: string[]) => Promise<string>;

/** Strip every TMUX* variable so a streamer started inside tmux cannot target its own server. */
function tmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("TMUX")) out[k] = v;
  return out;
}

export function createTmuxExec(
  tmuxPath: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): TmuxExec {
  const env = tmuxEnv(opts.env ?? process.env);
  const timeout = opts.timeoutMs ?? TMUX_TIMEOUT_MS;
  return (socketPath, args) =>
    new Promise((resolve, reject) => {
      execFile(
        tmuxPath,
        ["-N", "-S", socketPath, ...args],
        { env, timeout, maxBuffer: TMUX_MAX_BUFFER, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) return reject(new TmuxError("tmux timed out", "TMUX_TIMEOUT"));
          const text = String(stderr ?? "");
          if (/no server running|error connecting|server exited/i.test(text)) {
            return reject(new TmuxError("tmux server not running", "TMUX_NO_SERVER"));
          }
          // stderr can echo a target; keep it out of the message that reaches logs.
          reject(new TmuxError("tmux command failed", "TMUX_FAILED"));
        },
      );
    });
}

/** `tmux 3.4`, `tmux 3.3a`, `tmux next-3.5` → `{3, 4}`; null when unparseable. */
export function parseTmuxVersion(output: string): { major: number; minor: number } | null {
  const m = /(\d+)\.(\d+)/.exec(output);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

export function tmuxVersionSupported(v: { major: number; minor: number } | null): boolean {
  if (!v) return false;
  if (v.major !== TMUX_MIN_VERSION.major) return v.major > TMUX_MIN_VERSION.major;
  return v.minor >= TMUX_MIN_VERSION.minor;
}

export function readTmuxVersion(tmuxPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(tmuxPath, ["-V"], { timeout: TMUX_TIMEOUT_MS, encoding: "utf8" }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
}

/** Pane ids are `%<digits>`; nothing else is ever passed to `-t`. */
export function isPaneId(value: string): value is `%${number}` {
  return /^%\d{1,9}$/.test(value);
}

export const MAX_LITERAL_BYTES = 4 * 1024;

/**
 * Whether text may be typed into a pane as literal keys: well-formed UTF-8 of
 * at most 4 KiB with no C0/C1 controls, DEL, or lone surrogates. A newline is a
 * control character too: Enter is a separate, explicit action, because a
 * pending approval reads it as consent.
 */
export function isSafeLiteral(text: string): boolean {
  if (text.length === 0) return false;
  if (Buffer.byteLength(text, "utf8") > MAX_LITERAL_BYTES) return false;
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))
    return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  return !/[\u0000-\u001f\u007f-\u009f]/.test(text);
}

/**
 * `send-keys -H` arguments that type `text` byte for byte.
 *
 * Hex tokens are the only argv shape tmux's parser cannot reinterpret: no
 * `;`, no leading `-`, no `#{}` format, no quotes. `-l` with the raw string
 * was measured to drop a trailing `;` and to swallow a lone `;` argument.
 */
export function hexKeyArgs(paneId: `%${number}`, text: string): string[] {
  if (!isPaneId(paneId)) throw new Error("invalid pane id");
  if (!isSafeLiteral(text)) throw new Error("unsafe literal");
  const bytes = [...Buffer.from(text, "utf8")].map((b) => b.toString(16).padStart(2, "0"));
  return ["send-keys", "-H", "-t", paneId, ...bytes];
}
