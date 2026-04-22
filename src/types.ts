// ─── Session Lifecycle ─────────────────────────────────────────────

export type SessionStatus = "running" | "waiting_input" | "completed" | "failed";

export interface ManagedSession {
  id: string;
  conversationId: string;
  projectPath: string;
  projectName: string;
  branch: string;
  status: SessionStatus;
  startedAt: Date;
  completedAt: Date | null;
  promptCount: number;
  lastOutput: string;
}

export interface DiscoveredProcess {
  pid: number;
  projectPath: string;
  projectName: string;
  branch: string;
  conversationId: string | null;
  startedAt: Date;
}

// ─── WebSocket Messages ────────────────────────────────────────────

export type WSMessage =
  | { type: "terminal_output"; sessionId: string; data: string }
  | { type: "session_update"; session: SessionResponse }
  | { type: "session_list"; sessions: SessionResponse[] }
  | { type: "conversation_event"; sessionId: string; line: string }
  | { type: "ping"; ts: number };

// ─── REST Response Shapes ──────────────────────────────────────────

export interface SessionResponse {
  id: string;
  status: SessionStatus;
  projectPath: string;
  projectName: string;
  branch: string;
  lastOutput: string;
  elapsedMs: number;
  promptCount: number;
  startedAt: string;
  completedAt: string | null;
  conversationId: string;
  source: "managed" | "discovered";
  pid?: number;
}

export interface ConversationListResponse {
  conversations: unknown[];
  hasMore: boolean;
  offset: number;
  total: number;
}

// ─── Configuration ─────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  apiKey?: string;
  localNoAuth?: boolean;
  verbose?: boolean;
  scanProfiles?: Array<{
    id: string;
    label: string;
    configDir: string;
    enabled: boolean;
    emoji: string;
  }>;
}

// ─── PTY Manager ───────────────────────────────────────────────────

export interface PTYManagerOptions {
  onOutput?: (sessionId: string, data: string) => void;
  onStatusChange?: (session: ManagedSession) => void;
}

export interface StartSessionOptions {
  conversationId: string;
  projectPath: string;
  projectName?: string;
  branch?: string;
}

// ─── File Watcher ──────────────────────────────────────────────────

export interface FileWatcherEvents {
  onNewLine?: (filePath: string, line: string) => void;
  onError?: (filePath: string, error: Error) => void;
}
