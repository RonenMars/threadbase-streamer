import type { IncomingMessage, ServerResponse } from "http";
import type { WebSocket } from "ws";
import type { AgentClient } from "../../agent/agent-client";
import type { AgentConfig } from "../../agent/agent-config";
import type { ConversationWriter } from "../../agent/conversation-writer";
import type { ConversationCache } from "../../conversation-cache";
import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import type { ProjectsRepository } from "../../db/repositories/projects.repository";
import type { SessionsRepository } from "../../db/repositories/sessions.repository";
import type { LiveSessionManager } from "../../live-session-manager";
import type { SessionStore } from "../../session-store";
import type { WSHub } from "../../ws-hub";

export type ApiDeps = {
  apiKey: string;
  localNoAuth: boolean;
  logMenubarRequests: boolean;
  rotateApiKey: () => { newKey: string; persisted: boolean };
  publicUrl: string | null;
  browseRoot: string | null;
  browserCors: string | undefined;
  ptyManager: LiveSessionManager;
  sessionStore: SessionStore;
  wsHub: WSHub;
  cache: () => ConversationCache | null;
  projectsRepo: () => ProjectsRepository | null;
  conversationsRepo: () => ConversationsRepository | null;
  sessionsRepo: () => SessionsRepository | null;
  cacheMetadataRepo: () => CacheMetadataRepository | null;
  ptyAttachedIds: () => Set<string>;
  // Session handler delegates — called by Hono handlers, implemented by StreamerServer
  handleListSessions: (url: URL, res: ServerResponse) => Promise<void>;
  handleSessionsCount: (res: ServerResponse) => void;
  handleGetRecentSessions: (url: URL, res: ServerResponse) => void;
  handleGetSessionNames: (res: ServerResponse) => void;
  handleGetSession: (sessionId: string, res: ServerResponse) => void;
  handleGetOutput: (sessionId: string, res: ServerResponse) => void;
  handleSendInput: (sessionId: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleSendAnswer: (sessionId: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleCancel: (sessionId: string, res: ServerResponse) => void;
  handleStopSession: (sessionId: string, res: ServerResponse) => Promise<void>;
  handleSetSessionName: (
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  handleUploadFile: (sessionId: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleAdopt: (sessionId: string, res: ServerResponse) => Promise<void>;
  handleResume: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleStartSession: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  // Conversations / search / projects / browse / pair delegates
  handleListConversations: (url: URL, res: ServerResponse) => Promise<void>;
  handleConversationsCount: (url: URL, res: ServerResponse) => Promise<void>;
  handleGetConversation: (
    id: string,
    url: URL,
    res: ServerResponse,
    ifNoneMatch?: string,
  ) => Promise<void>;
  handleSearch: (url: URL, res: ServerResponse) => Promise<void>;
  handleListProjects: (url: URL, res: ServerResponse) => void;
  handleGetPopularProjects: (url: URL, res: ServerResponse) => void;
  handlePairStart: (res: ServerResponse) => void;
  handlePairExchange: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleBrowse: (url: URL, res: ServerResponse) => Promise<void>;
  handleMkdir: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  // WebSocket lifecycle delegates
  handleWsOpen: (ws: WebSocket) => void;
  handleWsMessage: (ws: WebSocket, raw: unknown) => void;
  handleWsClose: (ws: WebSocket) => void;
  // Multi-agent mode. Null when MULTI_AGENT_FLOW is OFF.
  agentClient: AgentClient | null;
  conversationWriter: ConversationWriter | null;
  agentConfig: AgentConfig;
};
