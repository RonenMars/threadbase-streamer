import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/smoke-isolated.sh boots the built CLI, so its happy path needs a
 * build and a free port and is run by hand (docs/guides/isolated-smoke.md).
 * What is pinned here is the part that runs before any server is spawned: the
 * three guards that must refuse with exit 2 instead of starting something, or
 * worse, reporting a pass or fail about the wrong thing.
 *
 * Method: run the real script out of process. It `cd`s to the parent of its own
 * directory, so a copy dropped into a scratch `<root>/scripts/` treats <root>
 * as the repo — which lets each case decide whether `dist/` and the fixture
 * exist without touching the real ones.
 *
 * Every case asserts the exact abort line, not only the exit code: exit 2 is
 * what all three guards share, so the code alone cannot tell which one fired.
 * The "no sessionId" case is the positive control — it is only reachable if the
 * dist, fixture and port guards all let a valid setup through.
 */

const SCRIPT = resolve(import.meta.dirname, "../scripts/smoke-isolated.sh");
const FIXTURE = "__tests__/fixtures/providers/claude-code/2.1.214/conversation.jsonl";

const roots: string[] = [];
const servers: Server[] = [];

function scratchRoot(opts: { dist: boolean; fixture: string | null }): string {
  const root = mkdtempSync(join(tmpdir(), "smoke-script-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(SCRIPT, join(root, "scripts", "smoke-isolated.sh"));
  if (opts.dist) {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "cli.cjs"), "");
  }
  if (opts.fixture !== null) {
    mkdirSync(dirname(join(root, FIXTURE)), { recursive: true });
    writeFileSync(join(root, FIXTURE), opts.fixture);
  }
  return root;
}

function run(root: string, port: number) {
  return spawnSync("bash", [join(root, "scripts", "smoke-isolated.sh")], {
    encoding: "utf8",
    env: { ...process.env, SMOKE_PORT: String(port) },
    timeout: 20_000,
    // Bash defers its TERM trap until the foreground command ends, so the
    // default SIGTERM can leave a wedged script running forever.
    killSignal: "SIGKILL",
  });
}

/** A port held open by this process; the script's probe must see it as taken. */
async function heldPort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return (server.address() as { port: number }).port;
}

/** A port that was free a moment ago: bind, read it, release. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok()));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("smoke-isolated.sh guards", () => {
  it("is executable, since the docs invoke it directly", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("refuses with exit 2 when dist/cli.cjs has not been built", () => {
    const r = run(scratchRoot({ dist: false, fixture: '{"sessionId": "x"}\n' }), 8799);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("SMOKE ABORT: dist/cli.cjs missing");
  });

  it("refuses with exit 2 when the fixture is missing", () => {
    const r = run(scratchRoot({ dist: true, fixture: null }), 8799);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(`SMOKE ABORT: fixture ${FIXTURE} missing`);
  });

  it("refuses with exit 2 when the port is already in use", async () => {
    const port = await heldPort();
    const r = run(scratchRoot({ dist: true, fixture: '{"sessionId": "x"}\n' }), port);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(`SMOKE ABORT: port ${port} is already in use`);
  });

  it("gets past all three guards on a valid setup, then stops at a fixture with no sessionId", async () => {
    const r = run(scratchRoot({ dist: true, fixture: "{}\n" }), await freePort());
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(`SMOKE ABORT: no sessionId in ${FIXTURE}`);
    expect(r.stdout).not.toContain("is already in use");
    expect(r.stdout).not.toContain("missing");
  });
});
