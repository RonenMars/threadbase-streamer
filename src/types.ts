// ─── Session Lifecycle ─────────────────────────────────────────────

export type SessionStatus = "running" | "waiting_input" | "idle";

export interface ManagedSession {
  id: string; // JSONL UUID — the .jsonl filename under ~/.claude/projects/
  projectPath: string;
  projectName: string;
  branch: string;
  status: SessionStatus;
  startedAt: Date;
  completedAt: Date | null;
  promptCount: number;
  lastOutput: string;
  failureReason?: string;
  sessionName?: string;
  model?: string;
  account?: string;
  messageCount?: number;
  preview?: string;
  firstMessageText?: string;
  firstMessageAt?: Date;
  lastMessageText?: string;
  lastMessageAt?: Date;
  lastActivityAt?: Date;
  filePath?: string;
}

export interface DiscoveredProcess {
  pid: number;
  projectPath: string;
  projectName: string;
  branch: string;
  conversationId: string | null; // JSONL UUID extracted from --resume arg
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
  id: string; // JSONL UUID
  status: SessionStatus;
  projectPath: string;
  projectName: string;
  branch: string;
  lastOutput: string;
  elapsedMs: number;
  promptCount: number;
  startedAt: string;
  completedAt: string | null;
  ptyAttached: boolean; // true when a live PTY is spawned for this session
  failureReason?: string;
  pid?: number;
  sessionName?: string;
  model?: string;
  account?: string;
  messageCount?: number;
  preview?: string;
  firstMessageText?: string;
  firstMessageAt?: string;
  lastMessageText?: string;
  lastMessageAt?: string;
  lastActivityAt?: string;
  filePath?: string;
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
  browseRoot?: string;
  publicUrl?: string;
  disableDb?: boolean;
  scanProfiles?: Array<{
    id: string;
    label: string;
    configDir: string;
    enabled: boolean;
    emoji: string;
  }>;
  ptyGracePeriodMs?: number; // ms to wait after WS disconnect before killing PTY (default 45000)
  cacheDir?: string;
  tailSize?: number;
}

// ─── PTY Manager ───────────────────────────────────────────────────

export interface PTYManagerOptions {
  onOutput?: (sessionId: string, data: string) => void;
  onStatusChange?: (session: ManagedSession) => void;
}

export interface StartSessionOptions {
  projectPath: string;
  projectName?: string;
  branch?: string;
}

export interface StartFreshSessionOptions {
  projectPath: string;
  projectName?: string;
  systemPrompt?: string;
}

// ─── File Watcher ──────────────────────────────────────────────────

export interface FileWatcherEvents {
  onNewLine?: (filePath: string, line: string) => void;
  onError?: (filePath: string, error: Error) => void;
}
