/**
 * `tb-streamer mcp`: a read-only MCP server over stdio for the streamer already
 * running on this machine (#1176 phase 1). Loaded lazily by the CLI action so
 * `serve` never pays for the SDK.
 *
 * Adding a tool (#1178-#1180): one file exporting a `StreamerTool[]`, one import
 * here, one entry in `TOOLS`. No `console.log` anywhere this module imports:
 * stdout is the protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getVersion } from "../../src/version";
import { StreamerClient, type StreamerClientOptions, type StreamerTool } from "./client";
import { streamerInfoTools } from "./streamer-info";

const TOOLS: StreamerTool[] = [...streamerInfoTools];

export function createMcpServer(opts: StreamerClientOptions): McpServer {
  const client = new StreamerClient(opts);
  const server = new McpServer({ name: "threadbase", version: getVersion() });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true },
      },
      // A thrown Error becomes an `isError` result with its message as the text.
      (args) => tool.handler(args, client),
    );
  }
  return server;
}

// `--port` wins, then THREADBASE_PORT (empty counts as unset), then 8766.
export function resolvePort(flag: string | undefined, env: string | undefined): number {
  const raw = flag ?? (env || "8766");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${raw}": expected an integer between 1 and 65535.`);
  }
  return port;
}

export interface RunMcpOptions {
  host: string;
  port: number;
  apiKey: string | undefined;
}

/** Resolves once the transport is up; the process ends when the client closes stdin. */
export async function runMcp(opts: RunMcpOptions): Promise<void> {
  const server = createMcpServer({
    baseUrl: `http://${opts.host}:${opts.port}`,
    apiKey: opts.apiKey,
    fetchFn: fetch,
  });
  await server.connect(new StdioServerTransport());
}
