import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Every server→client WebSocket frame must leave through `WSHub`, because the
 * hub is where per-socket sealing will live (specs/end-to-end-encryption/
 * design.md §3.6). A send that bypasses it would emit plaintext on a socket
 * declared sealed, and would do so silently.
 *
 * The pattern is identifier-qualified rather than a bare `.send(`: at the time
 * this was written a bare `.send(` had twelve legitimate hits in `src/`
 * (`transport.send`/`t.send` in `src/pty-host/*`, `sender.send`/`this.apns.send`
 * in `src/services/push/*`), while this pattern had none outside `ws-hub.ts`.
 *
 * Known ceiling: a bypass written through a differently-named binding
 * (`conn.send(...)`) is not caught. The type-level alternative — giving the
 * handlers a `ws` parameter typed `Omit<WebSocket, "send">` so `tsc` refuses
 * the bypass outright — is the stronger fix and is deliberately left as a
 * follow-up rather than widened into this refactor.
 */

const BYPASS = /\b(ws|client|socket|sock)\.send\(/;
const SRC = join(__dirname, "..", "src");
const ALLOWED = join(SRC, "ws-hub.ts");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("no send bypasses WSHub", () => {
  const files = tsFiles(SRC).filter((f) => f !== ALLOWED);

  it("scans a non-empty set of files with a regex that actually fires", () => {
    // A glob that silently matched nothing would otherwise report success.
    expect(files.length).toBeGreaterThan(50);
    expect(BYPASS.test('ws.send(JSON.stringify({ type: "cache_ready" }))')).toBe(true);
  });

  it("finds no raw socket send outside ws-hub.ts", () => {
    const offenders = files
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ f, n: i + 1, line }))
          .filter(({ line }) => BYPASS.test(line)),
      )
      .map(({ f, n, line }) => `${f.slice(SRC.length + 1)}:${n}: ${line.trim()}`);

    expect(offenders).toEqual([]);
  });
});
