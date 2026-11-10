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
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamerServer } from "../../src/server";
import { createTestServer, FIXTURES_DIR, get, TEST_API_KEY } from "../contracts/test-helpers";

const FIXTURE_DIR = join(FIXTURES_DIR, "contract-projects");
const CLI = join(__dirname, "../../dist/cli.cjs");
const WRONG_KEY = "tb_wrong_key_for_the_mcp_e2e_suite";

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
        expect(tools.map((t) => t.name)).toEqual(["streamer_info", "read_conversation"]);
        const info = tools.find((t) => t.name === "streamer_info");
        expect(info).toBeDefined();
        expect(info?.description).toMatch(/\S/);
        // Phase 1 is read-only: every tool must say so to the host.
        for (const tool of tools) {
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
});
