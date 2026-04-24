import {
  applyIncludeFilter,
  applyPagination,
  applyProjectFilter,
  applySort,
  type Conversation,
  type ConversationMeta,
  ConversationScanner,
  type SortOrder,
  search,
} from "@threadbase/scanner";
import { existsSync, readdirSync } from "fs";
import { realpath } from "fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { homedir } from "os";
import { join } from "path";
import { WebSocketServer } from "ws";
import { loadBrowseRoot, validateApiKey } from "./auth";
import { createDirectory, listDirectories, resolveBrowsePath } from "./browse";
import { createPool, getDbConfig, maskConnectionString, runMigrations } from "./db";
import { PgSessionPersistence } from "./db/pg-session-persistence";
import { FileWatcher } from "./file-watcher";
import { discoverClaudeProcesses } from "./process-discovery";
import { PTYManager } from "./pty-manager";
import { SessionStore } from "./session-store";
import type { ServerConfig } from "./types";
import { WSHub } from "./ws-hub";

const BROWSE_SYSTEM_PROMPT = (browseRoot: string) =>
  `You are working within the project boundary: ${browseRoot}. ` +
  `Do not read, write, or execute commands that access files or directories outside this boundary.`;

export class StreamerServer {
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private ptyManager: PTYManager;
  private sessionStore: SessionStore;
  private wsHub: WSHub;
  private fileWatcher: FileWatcher;
  private sessionFileMap = new Map<string, string>(); // sessionId → JSONL filePath
  private scanner: ConversationScanner | null = null;
  private scannerReady: Promise<unknown> | null = null;
  private apiKey: string;
  private localNoAuth: boolean;
  private verbose: boolean;
  private scanProfiles:
    | Array<{ id: string; label: string; configDir: string; enabled: boolean; emoji: string }>
    | undefined;
  private dbPool: Awaited<ReturnType<typeof createPool>> | null = null;
  private browseRoot: string | null = null;

  constructor(config: ServerConfig & { apiKey: string }) {
    this.apiKey = config.apiKey;
    this.localNoAuth = config.localNoAuth ?? false;
    this.verbose = config.verbose ?? false;
    this.scanProfiles = config.scanProfiles;
    // Resolve browseRoot: env var > YAML config > CLI flag
    const rawRoot = process.env.THREADBASE_BROWSE_ROOT ?? loadBrowseRoot() ?? config.browseRoot;
    if (rawRoot) {
      realpath(rawRoot)
        .then((resolved) => {
          this.browseRoot = resolved;
          if (this.verbose) console.log(`Browse root: ${resolved}`);
        })
        .catch(() => {
          console.warn(`Warning: browse root does not exist: ${rawRoot}`);
        });
    }
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
    // Set up optional DB persistence (lazy import of pg to avoid loading native module when unused)
    const dbConfig = getDbConfig();
    if (dbConfig) {
      this.dbPool = await createPool(dbConfig);
      const persistence = new PgSessionPersistence(this.dbPool);
      this.sessionStore = new SessionStore(persistence);
      if (this.verbose) {
        console.log(`Database enabled: ${maskConnectionString(dbConfig.connectionString)}`);
      }
      await runMigrations(this.dbPool);
      await this.sessionStore.rehydrate();
      if (this.verbose) {
        console.log("Database migrations applied, sessions rehydrated");
      }
    }

    return new Promise((resolve) => {
      this.httpServer.listen(port, () => {
        if (this.verbose) {
          console.log(`Streamer server listening on port ${port}`);
        }
        // Warm the conversation index so the first History request is less likely to block on disk I/O.
        void this.getScanner().catch(() => {});
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.ptyManager.dispose();
    this.fileWatcher.dispose();
    this.wsHub.dispose();
    if (this.dbPool) {
      await this.dbPool.end();
    }
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

    if (this.verbose) {
      console.log(`${req.method} ${req.url}`);
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
      if (method === "GET" && path === "/api/profiles") return json(res, 200, []);
      if (method === "POST" && path === "/api/push/register") return json(res, 200, { ok: true });
      if (method === "GET" && path === "/api/conversations")
        return await this.handleListConversations(url, res);
      if (method === "GET" && path === "/api/search") return await this.handleSearch(url, res);
      if (method === "GET" && path === "/api/sessions") return this.handleListSessions(res);
      if (method === "POST" && path === "/api/sessions/resume")
        return await this.handleResume(req, res);
      if (method === "GET" && path === "/api/browse") return await this.handleBrowse(url, res);
      if (method === "POST" && path === "/api/browse/mkdir")
        return await this.handleMkdir(req, res);
      if (method === "POST" && path === "/api/sessions/start")
        return await this.handleStartSession(req, res);

      // Parameterized routes
      const convMatch = path.match(/^\/api\/conversations\/(.+)$/);
      if (method === "GET" && convMatch)
        return await this.handleGetConversation(decodeURIComponent(convMatch[1]), url, res);

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
      machineName: hostname(),
      platform: process.platform,
      activeSessions: this.sessionStore.list().filter((s: any) => s.status === "running").length,
    });
  }

  private async handleListConversations(url: URL, res: ServerResponse): Promise<void> {
    const limit = intParam(url, "limit", 50);
    const offset = intParam(url, "offset", 0);
    const sort = (url.searchParams.get("sort") ?? "recent") as SortOrder;
    const project = url.searchParams.get("project") ?? undefined;
    const bustCache = url.searchParams.get("refresh") === "1";

    // Reuse the same ConversationScanner as detail/search paths — a standalone `scan()`
    // rescans every JSONL on every request, which makes History feel very slow vs Sessions.
    if (bustCache) {
      this.scanner = null;
      this.scannerReady = null;
    }

    const scanner = await this.getScanner();
    let metas = [...scanner.getMetadataCache().values()];
    metas = applyIncludeFilter(metas, "conversations");
    if (project) {
      metas = applyProjectFilter(metas, project);
    }
    metas = applySort(metas, sort);
    const total = metas.length;
    const page = applyPagination(metas, limit, offset);

    const adapted = (page.items as ConversationMeta[]).map((c) => ({
      id:
        c.sessionId ||
        c.id
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "") ||
        c.id,
      title: c.projectName,
      sessionName: c.sessionName || undefined,
      filePath: c.filePath,
      projectPath: c.projectPath,
      branch: c.gitBranch ?? undefined,
      account: c.account,
      preview: c.preview || undefined,
      messageCount: c.messageCount,
      lastActivity: c.timestamp,
      firstMessage: c.firstMessage ?? undefined,
      lastMessage: c.lastMessage ?? undefined,
      model: c.model ?? undefined,
    }));
    json(res, 200, {
      conversations: adapted,
      hasMore: offset + limit < total,
      offset,
      total,
    });
  }

  private async getScanner(): Promise<ConversationScanner> {
    if (this.scanner) return this.scanner;
    if (this.scannerReady) {
      await this.scannerReady;
      if (this.scanner) return this.scanner;
    }
    this.scanner = new ConversationScanner();
    this.scannerReady = this.scanner.scan(this.scanProfiles ? { profiles: this.scanProfiles } : {});
    await this.scannerReady;
    return this.scanner;
  }

  private findJsonlPath(uuid: string): string | null {
    const projectsDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projectsDir)) return null;
    const filename = `${uuid}.jsonl`;
    for (const dir of readdirSync(projectsDir)) {
      // Direct conversation
      const fp = join(projectsDir, dir, filename);
      if (existsSync(fp)) return fp;
      // Subagent conversations: <project>/<parentId>/subagents/<agentId>.jsonl
      const projectDir = join(projectsDir, dir);
      try {
        for (const sub of readdirSync(projectDir)) {
          const subagentPath = join(projectDir, sub, "subagents", filename);
          if (existsSync(subagentPath)) return subagentPath;
        }
      } catch {
        // Not a directory or no access
      }
    }
    return null;
  }

  private async findConversationByUuid(uuid: string): Promise<Conversation | null> {
    // When scan profiles are configured, look up by sessionId in the scanner cache
    if (this.scanProfiles) {
      const scanner = await this.getScanner();
      const cache = scanner.getMetadataCache();
      for (const [filePath, meta] of cache) {
        if (meta.sessionId === uuid || meta.id === uuid) {
          return scanner.getConversation(filePath);
        }
      }
      return null;
    }

    // Fast path: direct file lookup by UUID without full scan
    const filePath = this.findJsonlPath(uuid);
    if (!filePath) return null;
    const scanner = await this.getScanner();
    // Ensure this file is in the metadata cache
    const meta = scanner.getMetadataCache().get(filePath);
    if (meta) return scanner.getConversation(filePath);
    // File found on disk but not in cache — re-scan
    this.scanner = null;
    this.scannerReady = null;
    const freshScanner = await this.getScanner();
    return freshScanner.getConversation(filePath);
  }

  private async handleGetConversation(id: string, url: URL, res: ServerResponse): Promise<void> {
    const conversation = await this.findConversationByUuid(id);
    if (!conversation) {
      json(res, 404, { error: "Conversation not found" });
      return;
    }

    const filtered = conversation.messages.filter((m: any) => {
      if (m.role === "user" && m.isToolResult) return false;
      return true;
    });
    const total = filtered.length;

    const usePaging = url.searchParams.has("msg_limit") || url.searchParams.has("before_index");

    let slice = filtered;
    let fromIdx = 0;
    let messagePagination: Record<string, unknown> | undefined;

    if (usePaging) {
      const limit = Math.min(Math.max(intParam(url, "msg_limit", 80), 1), 500);
      let beforeIndex = total;
      if (url.searchParams.has("before_index")) {
        beforeIndex = intParam(url, "before_index", total);
        beforeIndex = Math.min(Math.max(beforeIndex, 0), total);
      }
      const start = Math.max(0, beforeIndex - limit);
      slice = filtered.slice(start, beforeIndex);
      fromIdx = start;
      messagePagination = {
        total,
        before_index: beforeIndex,
        from_index: start,
        has_more_older: start > 0,
        next_before_index: start > 0 ? start : null,
      };
    }

    const messagesPayload = slice.map((m: any, localIdx: number) => ({
      message_index: fromIdx + localIdx,
      role: m.role,
      timestamp: m.timestamp,
      text: m.text,
      tool_calls: m.metadata?.toolUses ?? [],
      content: [
        ...(m.metadata?.toolUseBlocks ?? []).map((b: any) => ({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input,
        })),
        ...(m.metadata?.toolResults ?? []).map((r: any) => ({
          type: "tool_result",
          tool_use_id: r.toolUseId,
          content: JSON.stringify(r.content),
          is_error: r.isError ?? false,
        })),
      ],
    }));

    const body: Record<string, unknown> = {
      meta: {
        id: conversation.id,
        profile_id: (conversation as any).account,
        project_name: (conversation as any).projectName,
        project_path: (conversation as any).projectPath,
        file_path: (conversation as any).filePath,
        last_updated_at: (conversation as any).timestamp,
        message_count: (conversation as any).messageCount,
      },
      messages: messagesPayload,
    };
    if (messagePagination) body.message_pagination = messagePagination;
    json(res, 200, body);
  }

  private async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams.get("q") ?? "";
    if (!q) {
      json(res, 400, { error: "Missing query parameter: q" });
      return;
    }

    const limit = intParam(url, "limit", 50);
    const results = await search(q, {
      limit,
      include: "conversations",
      ...(this.scanProfiles ? { profiles: this.scanProfiles } : {}),
    });
    const adapted = results.map((r: any) => ({
      id:
        r.meta.sessionId ||
        r.meta.id
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "") ||
        r.meta.id,
      title: r.meta.projectName,
      sessionName: r.meta.sessionName || undefined,
      filePath: r.meta.filePath,
      projectPath: r.meta.projectPath,
      branch: r.meta.gitBranch ?? undefined,
      account: r.meta.account,
      preview: r.meta.preview || undefined,
      messageCount: r.meta.messageCount,
      lastActivity: r.meta.timestamp,
      firstMessage: r.meta.firstMessage ?? undefined,
      lastMessage: r.meta.lastMessage ?? undefined,
    }));
    json(res, 200, {
      conversations: adapted,
      hasMore: false,
      offset: 0,
      total: adapted.length,
    });
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
    const { conversationId, projectPath: explicitPath } = body;

    if (!conversationId) {
      json(res, 400, { error: "Missing conversationId" });
      return;
    }

    let projectPath = explicitPath;
    const conv = await this.findConversationByUuid(conversationId);
    if (!projectPath) {
      if (!conv) {
        json(res, 404, { error: "Conversation not found" });
        return;
      }
      projectPath = (conv as any).projectPath;
    }

    const session = await this.ptyManager.start({
      conversationId,
      projectPath,
      projectName: body.projectName,
      branch: body.branch,
    });

    // Enrich session with conversation metadata
    if (conv) {
      session.sessionName = (conv as any).sessionName ?? undefined;
      session.messageCount = (conv as any).messageCount ?? 0;
      session.account = (conv as any).account ?? undefined;
      session.filePath = (conv as any).filePath ?? undefined;

      // Look up ConversationMeta from scanner cache for richer fields
      const scanner = await this.getScanner();
      const meta = conv.filePath ? scanner.getMetadataCache().get(conv.filePath) : undefined;
      if (meta) {
        session.model = meta.model ?? undefined;
        session.preview = meta.preview ?? undefined;
        session.firstMessageText = meta.firstMessage?.text ?? undefined;
        session.firstMessageAt = meta.firstMessage?.timestamp
          ? new Date(meta.firstMessage.timestamp)
          : undefined;
        session.lastMessageText = meta.lastMessage?.text ?? undefined;
        session.lastMessageAt = meta.lastMessage?.timestamp
          ? new Date(meta.lastMessage.timestamp)
          : undefined;
      }
    }

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
      const promptCount = this.ptyManager.sendInput(sessionId, input);
      this.sessionStore.updateManaged(sessionId, { promptCount });
      const updated = this.sessionStore.get(sessionId);
      if (updated) {
        this.wsHub.broadcast({ type: "session_update", session: updated });
      }
      json(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send input";
      json(res, 400, { error: message });
    }
  }

  private handleGetOutput(sessionId: string, res: ServerResponse): void {
    // Discovered sessions (disc_*) have no PTY output — return empty
    if (sessionId.startsWith("disc_")) {
      json(res, 200, { output: "" });
      return;
    }
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

  private async handleStartSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.browseRoot) {
      json(res, 403, { error: "File browsing not configured. Set browseRoot on the server." });
      return;
    }
    const body = await readBody(req);
    const { path: relativePath } = body;

    if (typeof relativePath !== "string") {
      json(res, 400, { error: "Missing path field" });
      return;
    }

    let resolvedPath: string;
    try {
      resolvedPath = await resolveBrowsePath(this.browseRoot, relativePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid path";
      json(res, 400, { error: message });
      return;
    }

    try {
      const session = await this.ptyManager.startFresh({
        projectPath: resolvedPath,
        projectName: body.projectName,
        systemPrompt: BROWSE_SYSTEM_PROMPT(this.browseRoot),
      });

      this.sessionStore.addManaged(session);
      this.wsHub.broadcast({ type: "session_list", sessions: this.sessionStore.list() });

      const resp = this.sessionStore.get(session.id);
      json(res, 201, resp ?? session);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start session";
      console.error(`[startSession] ${message}`);
      json(res, 500, { error: message });
    }
  }

  // ─── File Watcher Wiring ─────────────────────────────────────────

  private async watchConversationFile(sessionId: string, conversationId: string): Promise<void> {
    try {
      const conversation = await this.findConversationByUuid(conversationId);
      if (conversation?.filePath) {
        this.sessionFileMap.set(sessionId, conversation.filePath);
        this.fileWatcher.watch(conversation.filePath);
      }
    } catch {
      // Best-effort: if we can't find the JSONL file, raw terminal output still works
    }
  }

  private async handleBrowse(url: URL, res: ServerResponse): Promise<void> {
    if (!this.browseRoot) {
      json(res, 403, { error: "File browsing not configured. Set browseRoot on the server." });
      return;
    }
    const relativePath = url.searchParams.get("path") ?? "";
    try {
      const resolved = await resolveBrowsePath(this.browseRoot, relativePath);
      const directories = await listDirectories(resolved);
      json(res, 200, { path: relativePath, directories });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Browse failed";
      json(res, 400, { error: message });
    }
  }

  private async handleMkdir(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.browseRoot) {
      json(res, 403, { error: "File browsing not configured. Set browseRoot on the server." });
      return;
    }
    const body = await readBody(req);
    const { path: relativePath, name } = body;
    if (!name || typeof name !== "string") {
      json(res, 400, { error: "Missing name field" });
      return;
    }
    try {
      const parentPath = await resolveBrowsePath(this.browseRoot, relativePath ?? "");
      await createDirectory(parentPath, name);
      const parentRelative = relativePath ?? "";
      const created = parentRelative ? `${parentRelative}/${name}` : name;
      json(res, 201, { created });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create directory";
      if (message.includes("already exists")) {
        json(res, 409, { error: message });
      } else if (message.includes("Invalid directory name")) {
        json(res, 400, { error: message });
      } else {
        json(res, 400, { error: message });
      }
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
