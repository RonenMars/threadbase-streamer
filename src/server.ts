import { getConversation, scan, search } from "@threadbase/scanner";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer } from "ws";
import { validateApiKey } from "./auth";
import { FileWatcher } from "./file-watcher";
import { discoverClaudeProcesses } from "./process-discovery";
import { PTYManager } from "./pty-manager";
import { SessionStore } from "./session-store";
import type { ServerConfig } from "./types";
import { WSHub } from "./ws-hub";

export class StreamerServer {
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private ptyManager: PTYManager;
  private sessionStore: SessionStore;
  private wsHub: WSHub;
  private fileWatcher: FileWatcher;
  private sessionFileMap = new Map<string, string>(); // sessionId → JSONL filePath
  private apiKey: string;
  private localNoAuth: boolean;
  private verbose: boolean;

  constructor(config: ServerConfig & { apiKey: string }) {
    this.apiKey = config.apiKey;
    this.localNoAuth = config.localNoAuth ?? false;
    this.verbose = config.verbose ?? false;
    this.sessionStore = new SessionStore();
    this.wsHub = new WSHub();

    this.fileWatcher = new FileWatcher({
      onNewLine: (filePath, line) => {
        // Find which session this file belongs to
        for (const [sessionId, watchedPath] of this.sessionFileMap) {
          if (watchedPath === filePath) {
            this.wsHub.broadcast({ type: "conversation_event", sessionId, line });
            break;
          }
        }
      },
    });

    this.ptyManager = new PTYManager({
      onOutput: (sessionId, data) => {
        this.wsHub.broadcast({ type: "terminal_output", sessionId, data });
      },
      onStatusChange: (session) => {
        this.sessionStore.updateManaged(session.id, {
          status: session.status,
          completedAt: session.completedAt,
        });
        // Stop watching JSONL when session completes
        if (session.status === "completed" || session.status === "failed") {
          const filePath = this.sessionFileMap.get(session.id);
          if (filePath) {
            this.fileWatcher.unwatch(filePath);
            this.sessionFileMap.delete(session.id);
          }
        }
        const resp = this.sessionStore.get(session.id);
        if (resp) {
          this.wsHub.broadcast({ type: "session_update", session: resp });
        }
      },
    });

    this.httpServer = createServer((req, res) => this.handleRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (req, socket, head) => {
      if (!this.authenticate(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wsHub.addClient(ws);
        // Send current session list on connect
        const sessions = this.sessionStore.list();
        ws.send(JSON.stringify({ type: "session_list", sessions }));
      });
    });
  }

  async listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(port, () => {
        if (this.verbose) {
          console.log(`Streamer server listening on port ${port}`);
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.ptyManager.dispose();
    this.fileWatcher.dispose();
    this.wsHub.dispose();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  // ─── Request Router ────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.authenticate(req)) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // Static routes
      if (method === "GET" && path === "/api/info") return this.handleInfo(res);
      if (method === "GET" && path === "/api/conversations")
        return await this.handleListConversations(url, res);
      if (method === "GET" && path === "/api/search") return await this.handleSearch(url, res);
      if (method === "GET" && path === "/api/sessions") return this.handleListSessions(res);
      if (method === "POST" && path === "/api/sessions/resume")
        return await this.handleResume(req, res);

      // Parameterized routes
      const convMatch = path.match(/^\/api\/conversations\/(.+)$/);
      if (method === "GET" && convMatch) return await this.handleGetConversation(convMatch[1], res);

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (method === "GET" && sessionMatch) return this.handleGetSession(sessionMatch[1], res);

      const inputMatch = path.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (method === "POST" && inputMatch)
        return await this.handleSendInput(inputMatch[1], req, res);

      const outputMatch = path.match(/^\/api\/sessions\/([^/]+)\/output$/);
      if (method === "GET" && outputMatch) return this.handleGetOutput(outputMatch[1], res);

      const cancelMatch = path.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) return this.handleCancel(cancelMatch[1], res);

      json(res, 404, { error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      json(res, 500, { error: message });
    }
  }

  // ─── Auth ──────────────────────────────────────────────────────

  private authenticate(req: IncomingMessage): boolean {
    if (this.localNoAuth && isLocalRequest(req)) return true;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return validateApiKey(authHeader.slice(7), this.apiKey);
    }

    // Fallback: query param (for WebSocket connections)
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const key = url.searchParams.get("key");
    if (key) return validateApiKey(key, this.apiKey);

    return false;
  }

  // ─── Handlers ──────────────────────────────────────────────────

  private handleInfo(res: ServerResponse): void {
    const { hostname } = require("os");
    json(res, 200, {
      version: "0.1.0",
      hostname: hostname(),
      platform: process.platform,
    });
  }

  private async handleListConversations(url: URL, res: ServerResponse): Promise<void> {
    const limit = intParam(url, "limit", 50);
    const offset = intParam(url, "offset", 0);
    const sort = url.searchParams.get("sort") ?? "recent";
    const project = url.searchParams.get("project") ?? undefined;

    const result = await scan({
      sort: sort as any,
      limit,
      offset,
      project,
    });

    json(res, 200, {
      conversations: result.conversations,
      hasMore: offset + limit < result.total,
      offset,
      total: result.total,
    });
  }

  private async handleGetConversation(id: string, res: ServerResponse): Promise<void> {
    const conversation = await getConversation(id);
    if (!conversation) {
      json(res, 404, { error: "Conversation not found" });
      return;
    }
    json(res, 200, conversation);
  }

  private async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams.get("q") ?? "";
    if (!q) {
      json(res, 400, { error: "Missing query parameter: q" });
      return;
    }

    const limit = intParam(url, "limit", 50);
    const results = await search(q, { limit });
    json(res, 200, results);
  }

  private handleListSessions(res: ServerResponse): void {
    // Refresh discovered processes
    try {
      const discovered = discoverClaudeProcesses();
      this.sessionStore.setDiscovered(discovered);
    } catch {
      // Discovery is best-effort
    }
    json(res, 200, this.sessionStore.list());
  }

  private handleGetSession(sessionId: string, res: ServerResponse): void {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }
    json(res, 200, session);
  }

  private async handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const { conversationId, projectPath } = body;

    if (!conversationId || !projectPath) {
      json(res, 400, { error: "Missing conversationId or projectPath" });
      return;
    }

    const session = await this.ptyManager.start({
      conversationId,
      projectPath,
      projectName: body.projectName,
      branch: body.branch,
    });

    this.sessionStore.addManaged(session);

    // Watch the conversation's JSONL file for structured events
    this.watchConversationFile(session.id, conversationId);

    const resp = this.sessionStore.get(session.id);
    this.wsHub.broadcast({ type: "session_list", sessions: this.sessionStore.list() });

    json(res, 201, resp ?? session);
  }

  private async handleSendInput(
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    const { input } = body;

    if (typeof input !== "string") {
      json(res, 400, { error: "Missing input field" });
      return;
    }

    try {
      this.ptyManager.sendInput(sessionId, input);
      json(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send input";
      json(res, 400, { error: message });
    }
  }

  private handleGetOutput(sessionId: string, res: ServerResponse): void {
    try {
      const output = this.ptyManager.getOutput(sessionId);
      json(res, 200, { output });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get output";
      json(res, 404, { error: message });
    }
  }

  private handleCancel(sessionId: string, res: ServerResponse): void {
    try {
      this.ptyManager.cancel(sessionId);
      json(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to cancel";
      json(res, 400, { error: message });
    }
  }

  // ─── File Watcher Wiring ─────────────────────────────────────────

  private async watchConversationFile(sessionId: string, conversationId: string): Promise<void> {
    try {
      const conversation = await getConversation(conversationId);
      if (conversation?.filePath) {
        this.sessionFileMap.set(sessionId, conversation.filePath);
        this.fileWatcher.watch(conversation.filePath);
      }
    } catch {
      // Best-effort: if we can't find the JSONL file, raw terminal output still works
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function intParam(url: URL, name: string, defaultValue: number): number {
  const val = url.searchParams.get(name);
  if (!val) return defaultValue;
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
