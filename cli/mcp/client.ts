/**
 * The one module in the MCP shim that knows it talks HTTP to a loopback
 * streamer (#1176 phase 1). Tools call `get()` and get JSON back; every
 * failure surfaces as a one-line Error whose message is what the agent sees,
 * so nothing here may carry the key, a port or a URL into that message.
 * Phase 3 swaps this transport for the relay and the tools do not change.
 */

import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface StreamerClientOptions {
  baseUrl: string;
  /** `undefined` when no key exists: every call then fails with the set-key error, and none is created. */
  apiKey: string | undefined;
  fetchFn: typeof fetch;
}

/** What each `cli/mcp/*.ts` tool file exports an array of; `index.ts` registers them. */
export interface StreamerTool<Shape extends ZodRawShapeCompat = ZodRawShapeCompat> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: ShapeOutput<Shape>, client: StreamerClient) => Promise<CallToolResult>;
  /** Defaults to `{ readOnlyHint: true }`; a tool that changes anything says so. */
  annotations?: ToolAnnotations;
}

/** A non-2xx answer; tools map the statuses they understand (404 → "no such session"). */
export class StreamerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The body's `code`, when the streamer sent one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export const NOT_RUNNING =
  "The Threadbase streamer is not running on this machine; start it with `tb-streamer serve` (or `tb-streamer service start`) and retry.";
export const KEY_MISSING =
  "No Threadbase API key found; start the streamer once or run `tb-streamer set-key` to create one.";
export const KEY_REJECTED =
  "The Threadbase streamer rejected the API key; run `tb-streamer set-key` with the key from the streamer's server.yaml.";

// A hostname check, not a resolution check: `localhost` is trusted to resolve to loopback.
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

export class StreamerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(opts: StreamerClientOptions) {
    const { hostname } = new URL(opts.baseUrl);
    if (!isLoopback(hostname)) {
      throw new Error(
        `The MCP shim only talks to a loopback streamer in phase 1; "${hostname}" is not one.`,
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn;
  }

  /** The only text the key could ride into a tool result is text we did not write; scrub it anyway. */
  private redact(text: string): string {
    return this.apiKey ? text.replaceAll(this.apiKey, "[redacted]") : text;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.apiKey) throw new Error(KEY_MISSING);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });
    } catch {
      throw new Error(NOT_RUNNING);
    }
    if (res.status === 401 || res.status === 403)
      throw new StreamerHttpError(res.status, KEY_REJECTED);
    const body = (await res.json().catch(() => null)) as
      | T
      | { error?: string; code?: string }
      | null;
    if (!res.ok) {
      const err =
        body && typeof body === "object" ? (body as { error?: string; code?: string }) : {};
      throw new StreamerHttpError(
        res.status,
        this.redact(
          `The streamer answered HTTP ${res.status}${err.error ? `: ${err.error}` : ""}.`,
        ),
        typeof err.code === "string" ? err.code : undefined,
      );
    }
    return body as T;
  }
}

export function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
