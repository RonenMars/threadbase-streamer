import type { Stage } from "@threadbase/agent-types";
import type { ProgressDedupeLRU } from "./agent/dedupe";

// ─── Session Lifecycle ─────────────────────────────────────────────

export type SessionStatus = "running" | "waiting_input" | "idle";

export interface ManagedSession {
  id: string; // JSONL UUID — the .jsonl filename under ~/.claude/projects/
  projectId?: string; // Stable identity into the projects table (added during migration).
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
  resumedFromConversationId?: string;

  /**
   * Multi-agent mode only. Per-session in-memory LRU of progress event ids
   * seen by the webhook receiver. Used to drop Temporal-replay duplicates
   * before they reach the WebSocket. See spec §7.1.
   */
  progressDedupeIds?: ProgressDedupeLRU;

  /** Multi-agent: current stage of the active turn (advisory; advisory wire field). */
  stage?: Stage | string;

  /** Multi-agent: ms since the session last emitted a stage transition. */
  stalledSinceMs?: number;

  /** Multi-agent: 1 or 2 when stage === "rework". */
  reworkAttempt?: number;

  /**
   * Multi-agent: id of the in-flight turn, or null when idle. Set when
   * `POST /api/sessions/:id/input` accepts a request; cleared by the webhook
   * receiver on stage=done or terminal_failure. Undefined in PTY mode.
   */
  currentTurnId?: string | null;

  /**
   * Multi-agent resume: stable identity of the underlying conversation
   * (the JSONL filename), distinct from `id` which is per-orchestrator-instance.
   * Undefined in PTY mode (PTY uses `resumedFromConversationId` instead).
   */
  conversationId?: string;
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
  | {
      type: "session_update";
      session?: SessionResponse;
      sessionId?: string;
      // Multi-agent additive fields. Existing clients ignore these.
      turnId?: string;
      stage?: Stage | string;
      stalledSinceMs?: number;
      reworkAttempt?: number;
    }
  | { type: "session_list"; sessions: SessionResponse[] }
  | { type: "conversation_event"; sessionId: string; line: string }
  | { type: "ping"; ts: number }
  | { type: "terminal_replay"; sessionId: string; lines: string[] }
  | { type: "session_ready"; session: SessionResponse }
  // Multi-agent additive variants. Old clients ignore unknown types.
  | {
      type: "agent_output";
      sessionId: string;
      turnId: string;
      role: "worker" | "reviewer" | "signoff";
      content: string;
      partial?: boolean;
      reviewerOverruled?: boolean;
      stage?: Stage | string;
      reworkAttempt?: number;
    }
  | {
      type: "turn_failure";
      sessionId: string;
      turnId: string;
      reason: string;
    }
  | { type: "cache_ready" };

// ─── REST Response Shapes ──────────────────────────────────────────

export interface SessionResponse {
  id: string; // JSONL UUID
  conversationId: string; // alias for id — mobile uses this to build deep-link URLs
  projectId?: string; // Stable identity into the projects table (added during migration).
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
  resumedFromConversationId?: string;
}

export interface ConversationListResponse {
  conversations: unknown[];
  hasMore: boolean;
  offset: number;
  total: number;
}

// ─── Sessions Pagination ───────────────────────────────────────────

export type SessionSortKey = "startedAt" | "lastActivityAt" | "projectName" | "status";
export type SortOrder = "asc" | "desc";

export interface SessionListPage {
  sessions: SessionResponse[];
  nextCursor: string | null;
  total: number;
}

export interface SessionListQuery {
  limit: number;
  cursor?: string;
  sortBy: SessionSortKey;
  order: SortOrder;
  status?: SessionStatus[];
}

// Decoded cursor payload. `k` is the value of the chosen sort key for the
// last item on the previous page; `id` is the tiebreaker.
export interface SessionCursor {
  k: string | number;
  id: string;
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
  ptyGracePeriodMs?: number; // ms to wait after WS disconnect before killing PTY (default 270000, 4.5 minutes)
  cacheDir?: string;
  tailSize?: number;
}

// ─── PTY Manager ───────────────────────────────────────────────────

export interface PTYManagerOptions {
  onOutput?: (sessionId: string, data: string) => void;
  onStatusChange?: (session: ManagedSession) => void;
  onReady?: (session: ManagedSession) => void;
  logger?: import("./logger").Logger;
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
