import { Terminal } from "@xterm/headless";
import type { ManagedSession, UserMessage } from "./types";

/**
 * Plumbing shared by the two PTY runners (`pty-manager.ts` for Claude,
 * `codex-pty-runner.ts` for Codex). These were duplicated byte-for-byte in both
 * files; the copies drifted only in their comments.
 *
 * Deliberately plumbing only. The two runners' *detection* logic stays
 * provider-specific and is not shared: Claude signals readiness with OSC 777
 * plus prompt markers, Codex with rendered status-bar predicates and no OSC at
 * all. Merging those would couple two independent provider contracts.
 */

// PTY geometry. The headless render terminal (session.screen) MUST match these
// so a provider's absolute cursor moves (ESC[<row>;<col>H) resolve to the same
// screen coordinates the real TUI is painting against.
export const PTY_COLS = 120;
export const PTY_ROWS = 40;
// Scrollback depth for the render terminal.
export const SCREEN_SCROLLBACK = 1000;
// Everything the render terminal can hold: its scrollback plus the viewport.
// This is what `subscribe_session` replays — "as much scrollback as the session
// still has", not a number picked independently of it. The client keeps its own
// retention cap (tb-mobile's VirtualTerminal, 10 000 rows), which is larger, so
// this terminal is the binding limit on both ends and neither side has to know
// the other's number.
export const REPLAY_MAX_LINES = SCREEN_SCROLLBACK + PTY_ROWS;

export function digestBytes(s: string): string {
  // Replace control chars with their hex form so logs are grep-able.
  // Building the regex via RegExp() sidesteps a Biome lint rule that flags
  // literal control characters in regex literals.
  const escaped = s
    .replace(new RegExp(String.fromCharCode(0x1b), "g"), "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  if (escaped.length <= 200) return escaped;
  return `${escaped.slice(0, 100)}…[${escaped.length - 200}B omitted]…${escaped.slice(-100)}`;
}

// node-pty is a native addon — import dynamically to allow graceful failure
let pty: typeof import("node-pty") | null = null;

export async function loadPty(): Promise<typeof import("node-pty")> {
  if (pty) return pty;
  try {
    pty = await import("node-pty");
    return pty;
  } catch (err) {
    throw new Error(
      "node-pty is required for PTY management but failed to load. " +
        "Ensure it is installed: npm install node-pty\n" +
        `Original error: ${err}`,
    );
  }
}

export interface InternalSession extends ManagedSession {
  process: any; // node-pty IPty
  outputBuffer: Buffer;
  // Headless terminal that renders the raw PTY stream into a real screen grid.
  // getOutputLines() reads its rendered buffer so replay reflects true screen
  // order rather than raw byte order (which both providers' absolute-cursor
  // repaints scramble — see getOutputLines for the desync this fixes).
  screen: Terminal;
  // Ground-truth user messages submitted to this PTY, oldest-first, capped at
  // INPUT_HISTORY_MAX. Recorded in writeSubmit(); replayed via getInputHistory().
  inputHistory: UserMessage[];
}

export function createScreen(): Terminal {
  return new Terminal({
    cols: PTY_COLS,
    rows: PTY_ROWS,
    scrollback: SCREEN_SCROLLBACK,
    allowProposedApi: true,
  });
}

// Strip ANSI escape sequences for clean text preview
export function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
