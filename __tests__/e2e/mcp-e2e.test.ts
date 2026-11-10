/**
 * End-to-end harness for the `tb-streamer mcp` shim (#1176, #1177).
 *
 * A real in-process streamer on fixture data, the BUILT `dist/cli.cjs` spawned
 * as a child exactly as an MCP client would spawn it, and the SDK's stdio
 * client driving it. Assertions are on tool results only.
 *
 * Needs `npm run build` first — the shim under test is the bundle, because the
 * stdout discipline (nothing but JSON-RPC frames) is a property of the bundle's
 * import order, not of the source modules.
 *
 * Later tickets add one `describe` block per tool below (#1178 list_sessions,
 * #1179 read_conversation, #1180 tail_terminal) and reuse `startShim`.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamerServer } from "../../src/server";
import type { DiscoveredProcess } from "../../src/types";
import { createTestServer, FIXTURES_DIR, get, TEST_API_KEY } from "../contracts/test-helpers";

const FIXTURE_DIR = join(FIXTURES_DIR, "contract-projects");
const CLI = join(__dirname, "../../dist/cli.cjs");
const WRONG_KEY = "tb_wrong_key_for_the_mcp_e2e_suite";

// Process discovery runs in this process (the streamer is in-process), so the
// real one would list whatever agents this host is running. It lists exactly
// the External fixture instead.
const discovered: DiscoveredProcess[] = [];
vi.mock("../../src/process-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/process-discovery")>()),
  discoverClaudeProcesses: async () => discovered,
}));

// ─── Harness ──────────────────────────────────────────────────────

/** A config dir the child reads through THREADBASE_CONFIG_DIR; no key file when `key` is omitted. */
function configDirWith(key?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-mcp-cfg-"));
  if (key) writeFileSync(join(dir, "server.yaml"), `api_key: ${key}\n`);
  return dir;
}

function childEnv(configDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.THREADBASE_PORT;
  return { ...env, THREADBASE_CONFIG_DIR: configDir, ...extra };
}

/** A port nothing listens on: bind 0, read it back, release it. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Shim {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

async function startShim(args: string[], env: Record<string, string>): Promise<Shim> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", ...args],
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "mcp-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  return { isError: res.isError === true, text: content.map((c) => c.text ?? "").join("\n") };
}

function expectNoKey(text: string): void {
  expect(text).not.toContain(TEST_API_KEY);
  expect(text).not.toContain(WRONG_KEY);
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ─── Suite ────────────────────────────────────────────────────────

// Needs a build (the shim lives in dist/). Skipped when dist/ is absent so a
// plain `npm test` does not fail; CI runs `npm run test:e2e` in the job that has dist.
describe.skipIf(!existsSync(CLI))("tb-streamer mcp (e2e)", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;
  let headers: Record<string, string>;
  let cfgOk: string;

  beforeAll(async () => {
    const ctx = await createTestServer(FIXTURE_DIR);
    server = ctx.server;
    port = ctx.port;
    baseUrl = ctx.baseUrl;
    headers = ctx.headers;
    cfgOk = configDirWith(TEST_API_KEY);
  });

  afterAll(async () => {
    await server.close();
  });

  describe("transport", () => {
    it("writes nothing but JSON-RPC frames to stdout and exits 0 when stdin closes", async () => {
      // An install dir WITH a .env: the install-env loader logs a pino line per
      // load at import time, and that line used to land on stdout. The sandboxed
      // HOME has no .env, so without this the test would pass against the bug;
      // the stderr assertion below is the positive control that it fired.
      // No key in the config dir: the missing-key error must travel as a tool
      // result frame on stdout, not as a stray line on either stream.
      const installDir = mkdtempSync(join(tmpdir(), "tb-mcp-install-"));
      writeFileSync(join(installDir, ".env"), "TB_MCP_E2E_DUMMY=1\n");
      const child = spawn(process.execPath, [CLI, "mcp", "--port", String(port)], {
        env: childEnv(configDirWith(), { THREADBASE_INSTALL_DIR: installDir }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += String(c);
      });
      child.stderr.on("data", (c) => {
        stderr += String(c);
      });
      const frame = (msg: unknown) => `${JSON.stringify(msg)}\n`;
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
          },
        }),
      );
      child.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
      child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
      child.stdin.write(
        frame({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "streamer_info", arguments: {} },
        }),
      );
      await waitFor(() => stdout.split("\n").filter((l) => l.includes('"id":3')).length >= 1);
      child.stdin.end();
      const code = await new Promise<number | null>((r) => child.on("exit", r));

      expect(code).toBe(0);
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const frames = lines.map(
        (line) => JSON.parse(line) as { jsonrpc?: string; id?: number; result?: unknown },
      );
      for (const parsed of frames) expect(parsed.jsonrpc).toBe("2.0");
      const call = frames.find((f) => f.id === 3)?.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(call.isError).toBe(true);
      expect(call.content[0].text).toContain("set-key");
      // The import-time install-env line went to stderr, as pino JSON.
      expect(stderr).toMatch(/"component":"install-env".*loaded 1 env var/);
      expectNoKey(stdout);
      expectNoKey(stderr);
    });

    it("refuses a non-loopback host before serving anything", async () => {
      const child = spawn(
        process.execPath,
        [CLI, "mcp", "--host", "example.com", "--port", String(port)],
        { env: childEnv(cfgOk), stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += String(c);
      });
      child.stderr.on("data", (c) => {
        stderr += String(c);
      });
      const code = await new Promise<number | null>((r) => child.on("exit", r));
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/loopback/);
      expectNoKey(stderr);
    });
  });

  describe("streamer_info", () => {
    it("lists exactly the phase-1 tools, each with a description", async () => {
      const shim = await startShim(["--port", String(port)], childEnv(cfgOk));
      try {
        const { tools } = await shim.client.listTools();
        // #1178-#1180 each extend this list; #1181 locks it at four.
        expect(tools.map((t) => t.name)).toEqual([
          "streamer_info",
          "read_conversation",
          "list_sessions",
          "tail_terminal",
        ]);
        const info = tools.find((t) => t.name === "streamer_info");
        expect(info).toBeDefined();
        expect(info?.description).toMatch(/\S/);
        // Phase 1 is read-only: every tool must say so to the host.
        for (const tool of tools) {
          expect(tool.description, tool.name).toMatch(/\S/);
          expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
        }
      } finally {
        await shim.close();
      }
    });

    it("returns version and providers from the running streamer", async () => {
      const expected = await get(baseUrl, "/api/info", headers);
      const shim = await startShim(["--port", String(port)], childEnv(cfgOk));
      try {
        const { isError, text } = await callText(shim.client, "streamer_info");
        expect(isError).toBe(false);
        const body = JSON.parse(text) as {
          reachable: boolean;
          version: string;
          providers: Array<{ name: string; available: boolean }>;
        };
        expect(body.reachable).toBe(true);
        expect(body.version).toBe(expected.body.version);
        expect(body.providers.map((p) => p.name)).toEqual(
          expect.arrayContaining(["claude-code", "codex-cli"]),
        );
        for (const p of body.providers) expect(typeof p.available).toBe("boolean");
        // Nothing local-only in the shape: phase 3 serves this over a relay.
        expect(text).not.toContain(String(port));
        expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
        expectNoKey(text);
        expectNoKey(shim.stderr());
      } finally {
        await shim.close();
      }
    });

    it("reads the port from THREADBASE_PORT when no flag is given", async () => {
      const shim = await startShim([], childEnv(cfgOk, { THREADBASE_PORT: String(port) }));
      try {
        const { isError } = await callText(shim.client, "streamer_info");
        expect(isError).toBe(false);
      } finally {
        await shim.close();
      }
    });

    it("lets --port win over THREADBASE_PORT", async () => {
      const dead = await closedPort();
      const shim = await startShim(
        ["--port", String(port)],
        childEnv(cfgOk, { THREADBASE_PORT: String(dead) }),
      );
      try {
        const { isError } = await callText(shim.client, "streamer_info");
        expect(isError).toBe(false);
      } finally {
        await shim.close();
      }
    });

    it("tells the user to start the streamer when nothing listens", async () => {
      const dead = await closedPort();
      const shim = await startShim(["--port", String(dead)], childEnv(cfgOk));
      try {
        const { isError, text } = await callText(shim.client, "streamer_info");
        expect(isError).toBe(true);
        expect(text).toMatch(/not running/i);
        expect(text).toMatch(/start/i);
        expect(text).not.toContain("\n");
        expectNoKey(text);
      } finally {
        await shim.close();
      }
    });

    it("names set-key when no API key exists, and creates none", async () => {
      const cfgEmpty = configDirWith();
      const shim = await startShim(["--port", String(port)], childEnv(cfgEmpty));
      try {
        const { isError, text } = await callText(shim.client, "streamer_info");
        expect(isError).toBe(true);
        // The "no key" sentence, not the "rejected" one: without the pre-flight the
        // shim would send `Bearer undefined`, get a 401, and still say set-key.
        expect(text).toMatch(/No Threadbase API key found.*set-key/);
        expect(text).not.toContain("\n");
        expect(existsSync(join(cfgEmpty, "server.yaml"))).toBe(false);
        expectNoKey(shim.stderr());
      } finally {
        await shim.close();
      }
    });

    it("names set-key when the streamer rejects the key", async () => {
      const shim = await startShim(["--port", String(port)], childEnv(configDirWith(WRONG_KEY)));
      try {
        const { isError, text } = await callText(shim.client, "streamer_info");
        expect(isError).toBe(true);
        expect(text).toContain("set-key");
        expect(text).not.toContain("\n");
        expectNoKey(text);
        expectNoKey(shim.stderr());
      } finally {
        await shim.close();
      }
    });
  });

  describe("read_conversation", () => {
    // contract-tool-use.jsonl: 6 messages, index 0..5, with tool_use / tool_result blocks.
    const ID = "sess-contract-tools";
    const read = async (args: Record<string, unknown>) => {
      const shim = await startShim(["--port", String(port)], childEnv(cfgOk));
      try {
        const { isError, text } = await callText(shim.client, "read_conversation", args);
        return { isError, text, stderr: shim.stderr() };
      } finally {
        await shim.close();
      }
    };

    it("returns the newest messages first, bounded by the page size", async () => {
      const { isError, text } = await read({ id: ID, limit: 2 });
      expect(isError).toBe(false);
      const body = JSON.parse(text) as {
        messages: Array<{ role: string; text: string }>;
        next_before_index: number | null;
      };
      // Index 5 is the closing assistant text; index 4 is a bare tool result, dropped.
      expect(body.messages).toEqual([
        { role: "assistant", text: "Done! The semicolon has been added." },
      ]);
      expect(body.next_before_index).toBe(4);
    });

    it("pages back to older messages with the returned cursor", async () => {
      const first = JSON.parse((await read({ id: ID, limit: 2 })).text) as {
        next_before_index: number;
      };
      const older = JSON.parse(
        (await read({ id: ID, limit: 2, before_index: first.next_before_index })).text,
      ) as { messages: Array<{ role: string; text: string }>; next_before_index: number | null };
      expect(older.messages).toEqual([{ role: "assistant", text: "I'll fix the issue." }]);
      expect(older.next_before_index).toBe(2);
      const oldest = JSON.parse((await read({ id: ID, limit: 10, before_index: 2 })).text) as {
        messages: Array<{ role: string; text: string }>;
        next_before_index: number | null;
      };
      expect(oldest.messages.map((m) => m.text)).toEqual([
        "I'll read the file first.",
        "Read and fix main.ts",
      ]);
      expect(oldest.next_before_index).toBeNull();
    });

    it("leaks no provider format, port, URL or key", async () => {
      const { text, stderr } = await read({ id: ID, limit: 10 });
      for (const leak of [
        "tool_use",
        "tool_result",
        "tu-read-1",
        "file_path",
        "tool_calls",
        "uuid",
      ]) {
        expect(text).not.toContain(leak);
      }
      expect(text).not.toContain(String(port));
      expect(text).not.toMatch(/https?:\/\/|localhost|127\.0\.0\.1/);
      expectNoKey(text);
      expectNoKey(stderr);
    });

    it("answers an unknown id with a one-line tool error", async () => {
      const { isError, text } = await read({ id: "no-such-session" });
      expect(isError).toBe(true);
      expect(text).toBe("Session not found: no-such-session.");
      expectNoKey(text);
    });
  });
  describe("list_sessions", () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const EXT_ID = uuid(99);
    const NEEDS_YOU_ID = uuid(4);
    // Named sessions, one property each that a filter keys on.
    const NAMED = [
      { id: uuid(1), provider: "claude-code", project: "alpha", status: "running" },
      { id: uuid(2), provider: "codex-cli", project: "alpha", status: "waiting_input" },
      { id: uuid(3), provider: "claude-code", project: "beta", status: "idle" },
      { id: NEEDS_YOU_ID, provider: "claude-code", project: "beta", status: "running" },
      { id: uuid(5), provider: "codex-cli", project: "gamma", status: "waiting_input" },
    ] as const;
    // Filler so the unfiltered list is longer than the default page.
    const FILLER = Array.from({ length: 20 }, (_, i) => uuid(100 + i));
    const ALL_IDS = [...NAMED.map((s) => s.id), ...FILLER, EXT_ID];
    const projectPath = (name: string) => join(tmpdir(), "tb-mcp-e2e-projects", name);

    interface Item {
      id: string;
      name: string | null;
      provider: string;
      projectName: string;
      projectPath: string;
      status: string;
      needsYou: boolean;
      ownership: string;
      lastActivityAt: string | null;
    }
    interface Page {
      sessions: Item[];
      nextCursor: string | null;
    }

    let shim: Shim;

    async function list(args: Record<string, unknown> = {}): Promise<Page> {
      const { isError, text } = await callText(shim.client, "list_sessions", args);
      expect(isError, text).toBe(false);
      expect(text).not.toContain(String(port));
      expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
      expectNoKey(text);
      return JSON.parse(text) as Page;
    }

    const ids = (page: Page) => page.sessions.map((s) => s.id).sort();

    beforeAll(async () => {
      const store = (server as any).sessionStore;
      const started = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, i));
      for (const [i, s] of NAMED.entries()) {
        store.addManaged({
          id: s.id,
          provider: s.provider,
          status: s.status,
          projectPath: projectPath(s.project),
          projectName: s.project,
          sessionName: `named ${i + 1}`,
          branch: "",
          promptCount: 1,
          startedAt: started(i),
          completedAt: null,
          lastOutput: "",
        });
      }
      for (const [i, id] of FILLER.entries()) {
        store.addManaged({
          id,
          provider: "claude-code",
          status: "idle",
          projectPath: projectPath("filler"),
          projectName: "filler",
          branch: "",
          promptCount: 0,
          startedAt: started(10 + i),
          completedAt: null,
          lastOutput: "",
        });
      }
      discovered.push({
        pid: 999_999,
        provider: "claude-code",
        projectPath: projectPath("beta"),
        projectName: "beta",
        branch: "",
        conversationId: EXT_ID,
        startedAt: started(50),
      });
      // Earlier describes share this server and may have cached an empty discovery.
      (server as any).discoveryCache = null;
      vi.spyOn((server as any).promptRegistry, "hasOpen").mockImplementation(
        (id: unknown) => id === NEEDS_YOU_ID,
      );
      shim = await startShim(["--port", String(port)], childEnv(cfgOk));
    });

    afterAll(async () => {
      await shim.close();
      vi.restoreAllMocks();
    });

    it("returns a bounded first page and a cursor with no input", async () => {
      const page = await list();
      expect(page.sessions).toHaveLength(20);
      expect(page.nextCursor).toEqual(expect.any(String));
      // Newest started first: the External one, then the fillers newest to oldest.
      expect(page.sessions.slice(0, 3).map((s) => s.id)).toEqual([EXT_ID, FILLER[19], FILLER[18]]);
    });

    it("returns each item in the documented compact shape", async () => {
      const page = await list({ project: "alpha" });
      // Fields an agent needs, nothing local-only (asserted in `list`).
      expect(page.sessions.find((s) => s.id === uuid(1))).toEqual({
        id: uuid(1),
        name: "named 1",
        provider: "claude-code",
        projectName: "alpha",
        projectPath: projectPath("alpha"),
        status: "running",
        needsYou: false,
        ownership: "threadbase",
        lastActivityAt: null,
      });
      expect(page.nextCursor).toBeNull();
    });

    it("walks every session through the cursor with no duplicates", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Page = await list({ limit: 7, ...(cursor ? { cursor } : {}) });
        expect(page.sessions.length).toBeLessThanOrEqual(7);
        seen.push(...page.sessions.map((s) => s.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(cursor).toBeNull();
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([...ALL_IDS].sort());
    });

    it("filters by project name or path", async () => {
      expect(ids(await list({ project: "alpha" }))).toEqual([uuid(1), uuid(2)]);
      expect(ids(await list({ project: projectPath("beta") }))).toEqual(
        [uuid(3), NEEDS_YOU_ID, EXT_ID].sort(),
      );
      expect(ids(await list({ project: `${projectPath("alpha")}/` }))).toEqual([uuid(1), uuid(2)]);
    });

    it("filters by provider", async () => {
      expect(ids(await list({ provider: "codex-cli" }))).toEqual([uuid(2), uuid(5)]);
    });

    it("filters by status", async () => {
      expect(ids(await list({ status: "waiting_input" }))).toEqual([uuid(2), uuid(5)]);
      expect(ids(await list({ status: "running" }))).toEqual([uuid(1), NEEDS_YOU_ID]);
    });

    it("filters by needs-you", async () => {
      const page = await list({ needsYou: true });
      expect(ids(page)).toEqual([NEEDS_YOU_ID]);
      expect(page.sessions[0].needsYou).toBe(true);
      const notYou = ids(await list({ needsYou: false, project: "beta" }));
      expect(notYou).toEqual([uuid(3), EXT_ID].sort());
    });

    it("pages a filtered list without losing or repeating a match", async () => {
      const first = await list({ provider: "claude-code", project: "beta", limit: 2 });
      expect(first.sessions).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const rest = await list({
        provider: "claude-code",
        project: "beta",
        limit: 2,
        cursor: first.nextCursor,
      });
      expect([...ids(first), ...ids(rest)].sort()).toEqual([uuid(3), NEEDS_YOU_ID, EXT_ID].sort());
    });

    it("lists a session Threadbase did not start as External", async () => {
      const page = await list({ project: "beta" });
      const ext = page.sessions.find((s) => s.id === EXT_ID);
      expect(ext?.ownership).toBe("external");
      expect(ext?.provider).toBe("claude-code");
      expect(page.sessions.filter((s) => s.id !== EXT_ID).map((s) => s.ownership)).toEqual([
        "threadbase",
        "threadbase",
      ]);
    });

    it("rejects on_hold as an error instead of mapping it to another status", async () => {
      const { isError } = await callText(shim.client, "list_sessions", { status: "on_hold" });
      expect(isError).toBe(true);
    });
  });
  // The stand-in CLI is a shebang script, so the PTY block cannot run on Windows.
  describe.skipIf(process.platform === "win32")("tail_terminal", () => {
    // A real PTY running a stand-in for the Claude CLI that paints coloured and
    // private-mode output, so the tool is exercised against the real output route.
    // Own server: starting a session needs `browseRoot`, which the shared one lacks.
    let tail: Awaited<ReturnType<typeof createTestServer>>;
    let liveId: string;
    let workDir: string;
    let tcfg: string;
    let tailCache: string;

    beforeAll(async () => {
      workDir = realpathSync(mkdtempSync(join(tmpdir(), "tb-mcp-tail-")));
      tailCache = mkdtempSync(join(tmpdir(), "tb-mcp-tail-cache-"));
      tail = await createTestServer(FIXTURE_DIR, { browseRoot: workDir, cacheDir: tailCache });
      const fake = join(workDir, "fake-claude.sh");
      writeFileSync(
        fake,
        [
          "#!/bin/sh",
          "printf '\\033[?1049h\\033[?25l\\033]0;title\\007\\033]777;notify;t;b\\033\\\\'",
          "i=1; while [ $i -le 120 ]; do printf '\\033[1;32mline %s\\033[0m\\r\\n' $i; i=$((i+1)); done",
          "printf '\\033[?2004hDONE\\033[?25h\\r\\n'",
          "sleep 60",
        ].join("\n"),
      );
      chmodSync(fake, 0o755);
      tcfg = mkdtempSync(join(tmpdir(), "tb-mcp-tail-cfg-"));
      writeFileSync(join(tcfg, "server.yaml"), `claude_executable: ${fake}\n`);
      const prev = process.env.THREADBASE_CONFIG_DIR;
      process.env.THREADBASE_CONFIG_DIR = tcfg;
      try {
        const res = await fetch(`${tail.baseUrl}/api/sessions/start`, {
          method: "POST",
          headers: { ...tail.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ path: "." }),
        });
        const started = (await res.json()) as { id?: string; session?: { id: string } };
        liveId = (started.session?.id ?? started.id) as string;
      } finally {
        if (prev === undefined) delete process.env.THREADBASE_CONFIG_DIR;
        else process.env.THREADBASE_CONFIG_DIR = prev;
      }
      const deadline = Date.now() + 15_000;
      for (;;) {
        const out = await get(tail.baseUrl, `/api/sessions/${liveId}/output`, tail.headers);
        if (String(out.body.output).includes("DONE")) break;
        if (Date.now() > deadline)
          throw new Error(`never DONE: ${JSON.stringify(out.body).slice(0, 300)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }, 30_000);

    afterAll(async () => {
      await tail.server.close();
      for (const d of [workDir, tcfg, tailCache]) rmSync(d, { recursive: true, force: true });
    });

    it("returns a bounded, readable tail with every control sequence stripped", async () => {
      const shim = await startShim(["--port", String(tail.port)], childEnv(cfgOk));
      try {
        const { isError, text } = await callText(shim.client, "tail_terminal", {
          sessionId: liveId,
          lines: 5,
        });
        expect(isError, text).toBe(false);
        const lines = text.split("\n");
        expect(lines).toHaveLength(5);
        expect(lines.at(-1)).toBe("DONE");
        expect(lines.at(-2)).toBe("line 120");
        // Nothing but plain text: no ESC, BEL or CR survives.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
        expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
        expect(text).not.toMatch(/\[\?\d+[hl]|777;notify|title/);
        expect(text).not.toContain(String(tail.port));
        expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
        expectNoKey(text);
      } finally {
        await shim.close();
      }
    });

    it("defaults to a bounded number of lines", async () => {
      const shim = await startShim(["--port", String(tail.port)], childEnv(cfgOk));
      try {
        const { text } = await callText(shim.client, "tail_terminal", { sessionId: liveId });
        expect(text.split("\n").length).toBeLessThanOrEqual(50);
        const over = await callText(shim.client, "tail_terminal", {
          sessionId: liveId,
          lines: 100_000,
        });
        expect(over.isError).toBe(true);
        // The bounds are exact: 0 would slice(-0) to everything, 501 is one past the max.
        for (const lines of [0, 501]) {
          const bad = await callText(shim.client, "tail_terminal", { sessionId: liveId, lines });
          expect(bad.isError, `lines=${lines}`).toBe(true);
        }
      } finally {
        await shim.close();
      }
    });

    it("says a session with no live terminal is not live, without an error", async () => {
      // A fixture conversation has a resumable shape (`on_hold`) and no PTY.
      const list = await get(tail.baseUrl, "/api/conversations?limit=1", tail.headers);
      const id: string = list.body.conversations[0].id;
      const shim = await startShim(["--port", String(tail.port)], childEnv(cfgOk));
      try {
        const { isError, text } = await callText(shim.client, "tail_terminal", { sessionId: id });
        expect(isError, text).toBe(false);
        expect(text).toMatch(/not live/i);
        expect(text.split("\n")).toHaveLength(1);
      } finally {
        await shim.close();
      }
    });

    it("answers an unknown session id with a one-line tool error", async () => {
      const shim = await startShim(["--port", String(tail.port)], childEnv(cfgOk));
      try {
        const { isError, text } = await callText(shim.client, "tail_terminal", {
          sessionId: "no-such-session",
        });
        expect(isError).toBe(true);
        expect(text).toMatch(/not found/i);
        expect(text.split("\n")).toHaveLength(1);
        expectNoKey(text);
      } finally {
        await shim.close();
      }
    });
  });
});
