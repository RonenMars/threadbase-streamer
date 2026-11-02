import { spawn } from "child_process";
import { createInterface } from "readline";

// Newline-delimited JSON-RPC 2.0 over the stdio of `codex app-server` (verified
// on codex-cli 0.166.0: one JSON object per line; responses omit "jsonrpc").

export interface AppServerTransport {
  pid: number | null;
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export function spawnAppServerTransport(exe: string, cwd: string): AppServerTransport {
  const child = spawn(exe, ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  const rl = createInterface({ input: child.stdout });
  return {
    pid: child.pid ?? null,
    write: (line) => child.stdin.write(`${line}\n`),
    onLine: (cb) => rl.on("line", cb),
    onExit: (cb) => {
      child.on("exit", (code) => cb(code));
      child.on("error", () => cb(null));
    },
    kill: (signal) => child.kill(signal),
  };
}

export interface JsonRpcHandlers {
  onNotification(method: string, params: unknown): void;
  /** A request FROM the server (approvals). The returned value is NOT sent; the client answers it with an error. */
  onServerRequest?(method: string, params: unknown): void;
  onClose(code: number | null): void;
}

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private closed = false;

  constructor(
    private readonly transport: AppServerTransport,
    private readonly handlers: JsonRpcHandlers,
  ) {
    transport.onLine((line) => this.handleLine(line));
    transport.onExit((code) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("codex app-server exited"));
      this.pending.clear();
      handlers.onClose(code);
    });
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON-RPC; ignore
    }
    if (msg === null || typeof msg !== "object") return;
    if (msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "JSON-RPC error"));
      else p.resolve(msg.result);
    } else if (msg.id === undefined) {
      this.handlers.onNotification(msg.method, msg.params);
    } else {
      // Server request: we implement no approval UI in this slice, so refuse it
      // rather than leave the turn waiting on an answer that never comes.
      this.handlers.onServerRequest?.(msg.method, msg.params);
      this.transport.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "not supported by this client" },
        }),
      );
    }
  }
}
