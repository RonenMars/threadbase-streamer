// Throwaway spike (#1201): replay raw PTY captures through @xterm/headless (createScreen)
// and ghostty-web's libghostty-vt WASM, then diff the rendered viewport rows.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ghostty } from "ghostty-web";
import xt from "@xterm/headless";
// Same options as createScreen() in src/pty-shared.ts:176 (ESM cannot named-import xterm's CJS build).
const { Terminal } = xt as unknown as typeof import("@xterm/headless");
const PTY_COLS = 120, PTY_ROWS = 40;
const createScreen = () => new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 1000, allowProposedApi: true });

interface Capture { submitAt: number; marks: Record<string, number>; chunks: [number, string][] }
const __dirname = new URL(".", import.meta.url).pathname;
const DIR = join(__dirname, "..", "__tests__", "fixtures", "turn-signals");
// ghostty-web loads its WASM with fetch(); Node fetch has no file:// support, so shim it.
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: any, i?: any) => String(u).startsWith("file:") ? Promise.resolve(new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } })) : realFetch(u, i)) as typeof fetch;
let ghostty: Ghostty;

const cell = (c: { codepoint: number; width: number }) => (c.width === 0 ? "" : String.fromCodePoint(c.codepoint || 32));

async function xtermRows(cap: Capture, ms: number): Promise<string[]> {
  const s = createScreen();
  for (const [at, d] of cap.chunks) { if (at > ms) break; await new Promise<void>((r) => s.write(d, () => r())); }
  const b = s.buffer.active, rows: string[] = [];
  for (let y = 0; y < PTY_ROWS; y++) rows.push((b.getLine(b.viewportY + y)?.translateToString(true) ?? "").trimEnd());
  s.dispose();
  return rows;
}

const wasmUrl = new URL("../node_modules/ghostty-web/ghostty-vt.wasm", import.meta.url).href;
async function ghosttyRows(cap: Capture, ms: number): Promise<string[]> {
  ghostty = await Ghostty.load(wasmUrl); // fresh WASM instance per replay: isolation control
  const t = ghostty.createTerminal(PTY_COLS, PTY_ROWS);
  for (const [at, d] of cap.chunks) { if (at > ms) break; t.write(d); }
  t.update(); // refresh the render state before reading rows
  const rows: string[] = [];
  for (let y = 0; y < PTY_ROWS; y++) rows.push((t.getLine(y) ?? []).map(cell).join("").trimEnd());
  t.free?.();
  return rows;
}

async function main() {
ghostty = await Ghostty.load(new URL("../node_modules/ghostty-web/ghostty-vt.wasm", import.meta.url).href);
let totalPts = 0, totalDiffPts = 0;
for (const f of readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
  const cap: Capture = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  const last = cap.chunks.at(-1)?.[0] ?? 0;
  const pts = [...new Set([...Object.values(cap.marks ?? {}), cap.submitAt, last])].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  let diffPts = 0, diffRows = 0; const samples: string[] = [];
  for (const ms of pts) {
    const a = await xtermRows(cap, ms), g = await ghosttyRows(cap, process.env.CONTROL ? ms + 4000 : ms);
    let d = 0;
    for (let y = 0; y < PTY_ROWS; y++) if (a[y] !== g[y]) { d++; if (samples.length < 3) samples.push(`  @${ms}ms row ${y}\n    xterm  : ${JSON.stringify(a[y])}\n    ghostty: ${JSON.stringify(g[y])}`); }
    if (d) { diffPts++; diffRows += d; }
  }
  totalPts += pts.length; totalDiffPts += diffPts;
  console.log(`${f}: ${pts.length} points, ${diffPts} differ (${diffRows} rows)`);
  for (const s of samples) console.log(s);
}
console.log(`TOTAL: ${totalPts} points, ${totalDiffPts} differ`);
}
main().catch((e) => { console.error(e); process.exit(1); });
