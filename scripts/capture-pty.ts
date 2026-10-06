/**
 * Record a raw PTY capture of a real agent CLI, in the fixture format
 * `__tests__/turn-signal-replay.test.ts` replays: `{ submitAt, chunks: [[ms, data]] }`,
 * ms since spawn.
 *
 * The CLI runs the way a runner spawns it: 120x40, `xterm-256color`, and a
 * launchd-like env (PATH and HOME plus the login basics, no TERM_PROGRAM), so a
 * capture shows what the supervised streamer would see rather than what a
 * terminal emulator coaxes out of the CLI.
 *
 *   npx tsx scripts/capture-pty.ts <scenario.json> <out.json>
 *
 * A scenario is `{ provider, command, args, cwd, steps }`. It is stored in the
 * capture under `scenario`, so a fixture says how it was made. `cwd` is created if
 * missing and is painted by most CLIs, so keep it neutral (`/tmp/tb-capture-…`).
 * Steps run in order:
 *
 *   { "wait": "text" }      until the rendered screen contains the text
 *   { "gone": "text" }      until the rendered screen no longer contains it
 *   { "quiet": 500 }        until no output has arrived for that many ms
 *   { "sleep": 500 }        a fixed pause
 *   { "write": "\r" }       raw bytes to the PTY
 *   { "submit": "prompt" }  text, its echo, a quiet beat, then `\r` in its own write; sets submitAt
 *   { "mark": "name" }      record the current ms under `marks.name`
 *   { "screen": "name" }    print the rendered screen to stdout
 *
 * `wait`, `gone` and `quiet` take an optional `"timeout"` in ms (default 30000).
 * A timeout still writes the capture, prints the screen, and exits 1.
 *
 * The capture is refused (exit 2, nothing written) if it contains this
 * machine's user name or home directory: fixtures land in a public repository.
 */
import fs from "fs";
import os from "os";
import { execFileSync } from "child_process";
import xterm from "@xterm/headless";
import nodePty from "node-pty";

// The runners' size (src/pty-shared.ts). Not imported: that module's named
// import of the CommonJS xterm build only resolves through a bundler.
const PTY_COLS = 120;
const PTY_ROWS = 40;

type Step = {
  wait?: string;
  gone?: string;
  quiet?: number;
  sleep?: number;
  write?: string;
  submit?: string;
  mark?: string;
  screen?: string;
  timeout?: number;
};

interface Scenario {
  provider: string;
  command: string;
  args?: string[];
  cwd: string;
  steps: Step[];
}

const [scenarioPath, outPath] = process.argv.slice(2);
if (!scenarioPath || !outPath) {
  console.error("usage: tsx scripts/capture-pty.ts <scenario.json> <out.json>");
  process.exit(64);
}
const scenario: Scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
fs.mkdirSync(scenario.cwd, { recursive: true });

const env: Record<string, string> = {};
for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR"]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}

let cliVersion = "unknown";
try {
  cliVersion = execFileSync(scenario.command, ["--version"], { env, encoding: "utf8" }).trim().split("\n")[0];
} catch {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const screen = new xterm.Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });
const chunks: [number, string][] = [];
const marks: Record<string, number> = {};
let submitAt: number | undefined;
// Infinity until the first chunk, so `quiet` cannot pass before the CLI has painted.
let lastChunkAt = Number.POSITIVE_INFINITY;
let exited = false;

async function main() {
  const startedAt = Date.now();
  const now = () => Date.now() - startedAt;
  const proc = nodePty.spawn(scenario.command, scenario.args ?? [], {
    name: "xterm-256color",
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: scenario.cwd,
    env,
  });
  proc.onData((data) => {
    chunks.push([now(), data]);
    lastChunkAt = Date.now();
    screen.write(data);
  });
  proc.onExit(() => {
    exited = true;
  });

  // The visible rows, after xterm has parsed everything written so far.
  const render = async () => {
    await new Promise<void>((resolve) => screen.write("", () => resolve()));
    const buf = screen.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < PTY_ROWS; y++) rows.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "");
    return rows.join("\n").trimEnd();
  };

  async function until(what: string, timeout: number, done: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + timeout;
    while (!(await done())) {
      if (exited) throw new Error(`process exited while waiting for ${what}`);
      if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
      await sleep(50);
    }
  }

  const quiet = (ms: number, timeout: number) =>
    until(`${ms} ms of quiet`, timeout, () => Date.now() - lastChunkAt >= ms);

  let failure: string | undefined;
  try {
    for (const step of scenario.steps) {
      const timeout = step.timeout ?? 30_000;
      if (step.wait !== undefined) {
        const text = step.wait;
        await until(`"${text}"`, timeout, async () => (await render()).includes(text));
      } else if (step.gone !== undefined) {
        const text = step.gone;
        await until(`"${text}" to leave`, timeout, async () => !(await render()).includes(text));
      } else if (step.quiet !== undefined) {
        await quiet(step.quiet, timeout);
      } else if (step.sleep !== undefined) {
        await sleep(step.sleep);
      } else if (step.write !== undefined) {
        proc.write(step.write);
      } else if (step.submit !== undefined) {
        // Enter must follow the echo: Cursor drops a `\r` that lands before it has
        // repainted the typed prompt (docs/troubleshooting.md#cursor-prompt-dropped).
        const before = chunks.length;
        proc.write(step.submit);
        await until("the prompt echo", timeout, () => chunks.length > before);
        await quiet(300, timeout);
        submitAt = now();
        proc.write("\r");
      } else if (step.mark !== undefined) {
        marks[step.mark] = now();
      } else if (step.screen !== undefined) {
        console.log(`----- ${step.screen} @ ${now()} ms\n${await render()}\n`);
      }
    }
  } catch (err) {
    failure = (err as Error).message;
    console.log(`----- at failure @ ${now()} ms\n${await render()}\n`);
  }
  if (!exited) proc.kill();

  const capture = {
    provider: scenario.provider,
    // The recipe travels with the evidence: `jq .scenario` gives the file to rerun.
    scenario,
    cliVersion,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    submitAt,
    marks,
    chunks,
  };
  const json = JSON.stringify(capture);
  const { username, homedir } = os.userInfo();
  const leaked = [username, homedir].filter((needle) => needle && json.includes(needle));
  if (leaked.length > 0) {
    console.error(`refused: the capture contains ${leaked.join(" and ")}; nothing written`);
    process.exit(2);
  }
  fs.writeFileSync(outPath, json);
  console.error(`${failure ? `FAILED (${failure}); ` : ""}${chunks.length} chunks → ${outPath}`);
  process.exit(failure ? 1 : 0);
}

void main();
