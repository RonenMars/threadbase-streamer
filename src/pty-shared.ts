import { type IMarker, Terminal } from "@xterm/headless";
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
// Lines kept from before the render terminal's full clears (see ClearArchive).
// Sized so archive + REPLAY_MAX_LINES stays near tb-mobile's default
// `terminalMaxLines` (5000): more would reach the client only to be cut there.
export const REPLAY_ARCHIVE_MAX_LINES = 4000;

// Called right after `await loadPty()`: a dispose() that lands inside that await
// (the first load is a real import) has already swept the runner, so a spawn
// past this point leaves a child nothing will ever kill.
export function refuseIfDisposed(disposed: boolean): void {
  if (disposed) throw new Error("Session runner is shut down; not starting a session");
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

/**
 * What a render terminal drew before its last full clear.
 *
 * Claude Code wipes its whole scrollback mid-turn: whenever its live frame is
 * taller than the viewport and a row above the viewport changes, its renderer
 * writes `ESC[2J ESC[3J ESC[H` and repaints only the current frame (verified
 * in Claude Code 2.1.42's renderer, reasons "resize" and "offscreen"). xterm
 * obeys, so `terminal_replay` used to carry one screen of history after any
 * long turn — which is what a reconnecting client, or a new one, then showed.
 *
 * This copies the rows a clear is about to erase into `archived`, from a
 * parser hook that runs before xterm's own handler. The marker records the
 * last buffer row already copied, so rows that survive a clear (`2J` keeps the
 * scrollback, `3J` keeps the viewport) are neither copied twice nor replayed
 * twice. A clear on the alternate buffer is a full-screen app redrawing, not
 * history, and is left alone.
 */
export class ClearArchive {
  private archived: string[] = [];
  private marker: IMarker | undefined;

  constructor(private readonly screen: Terminal) {
    screen.parser.registerCsiHandler({ final: "J" }, (params) => {
      const mode = typeof params[0] === "number" ? params[0] : 0;
      if (mode === 2 || mode === 3) this.capture(mode);
      // Never consume the sequence: xterm still has to perform the erase.
      return false;
    });
  }

  private firstUncopiedRow(): number {
    return this.marker && !this.marker.isDisposed ? this.marker.line + 1 : 0;
  }

  private capture(mode: 2 | 3): void {
    const buf = this.screen.buffer.active;
    if (buf.type !== "normal") return;
    // 2J erases the viewport and leaves the scrollback; 3J the reverse.
    const end = mode === 2 ? buf.length : buf.baseY;
    const rows = readRows(this.screen, this.firstUncopiedRow(), end);
    if (rows.length > 0) {
      this.archived.push(...rows);
      if (this.archived.length > REPLAY_ARCHIVE_MAX_LINES) {
        this.archived = this.archived.slice(-REPLAY_ARCHIVE_MAX_LINES);
      }
    }
    // Everything up to the end of the scrollback is now copied. The viewport's
    // rows are about to be blanked and reused, so the mark sits on the last
    // scrollback row; xterm disposes it if 3J or the scrollback cap removes it.
    this.marker?.dispose();
    this.marker = buf.baseY > 0 ? this.screen.registerMarker(-1 - buf.cursorY) : undefined;
  }

  /** Archived rows, then the rows drawn since, the latter capped at `maxLines`. */
  read(maxLines: number): ReplayLines {
    const buf = this.screen.buffer.active;
    const live = readRows(this.screen, this.firstUncopiedRow(), buf.length).slice(-maxLines);
    return {
      lines: [...this.archived, ...live],
      archivedLineCount: this.archived.length,
    };
  }
}

export interface ReplayLines {
  lines: string[];
  /**
   * How many leading entries of `lines` were on screen before the terminal's
   * last full clear. The client needs the boundary: those rows are history,
   * the rest is the frame the agent is painting now.
   */
  archivedLineCount: number;
}

function readRows(screen: Terminal, from: number, to: number): string[] {
  const buf = screen.buffer.active;
  const rows: string[] = [];
  for (let y = from; y < to; y++) {
    rows.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  while (rows.length > 0 && rows[rows.length - 1] === "") {
    rows.pop();
  }
  return rows;
}

// Keyed by the terminal rather than stored on InternalSession: every runner
// creates its screen through createScreen, so the archive exists wherever a
// screen does without five call sites having to carry a second field.
const archives = new WeakMap<Terminal, ClearArchive>();

export function createScreen(): Terminal {
  const screen = new Terminal({
    cols: PTY_COLS,
    rows: PTY_ROWS,
    scrollback: SCREEN_SCROLLBACK,
    allowProposedApi: true,
  });
  archives.set(screen, new ClearArchive(screen));
  return screen;
}

/**
 * What `terminal_replay` sends: the rows kept from before the last full clear,
 * then the rows since. Flushes pending writes first (xterm parses on a later
 * tick), the same way every runner's getOutputLines does.
 */
export async function readReplayLines(screen: Terminal, maxLines: number): Promise<ReplayLines> {
  await new Promise<void>((resolve) => screen.write("", () => resolve()));
  const archive = archives.get(screen);
  if (archive) return archive.read(maxLines);
  const buf = screen.buffer.active;
  return { lines: readRows(screen, 0, buf.length).slice(-maxLines), archivedLineCount: 0 };
}

// Strip ANSI escape sequences for clean text preview
export function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
