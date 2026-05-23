import type { IncomingMessage, ServerResponse } from "http";
import type { WebSocket } from "ws";
import type { ConversationCache } from "../../conversation-cache";
import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import type { ProjectsRepository } from "../../db/repositories/projects.repository";
import type { SessionsRepository } from "../../db/repositories/sessions.repository";
import type { PTYManager } from "../../pty-manager";
import type { SessionStore } from "../../session-store";
import type { WSHub } from "../../ws-hub";

export type ApiDeps = {
  apiKey: string;
  localNoAuth: boolean;
  publicUrl: string | null;
  browseRoot: string | null;
  ptyManager: PTYManager;
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
  handleCancel: (sessionId: string, res: ServerResponse) => void;
  handleSetSessionName: (
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  handleUploadFile: (sessionId: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleAdopt: (sessionId: string, res: ServerResponse) => Promise<void>;
  handleResume: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleStartSession: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  // Conversations / search / projects / browse / pair / project-chats delegates
  handleListConversations: (url: URL, res: ServerResponse) => Promise<void>;
  handleConversationsCount: (url: URL, res: ServerResponse) => Promise<void>;
  handleGetConversation: (id: string, url: URL, res: ServerResponse) => Promise<void>;
  handleSearch: (url: URL, res: ServerResponse) => Promise<void>;
  handleGetPopularProjects: (url: URL, res: ServerResponse) => void;
  handleListProjectChats: (url: URL, res: ServerResponse) => Promise<void>;
  handlePairStart: (res: ServerResponse) => void;
  handlePairExchange: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleBrowse: (url: URL, res: ServerResponse) => Promise<void>;
  handleMkdir: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  // WebSocket lifecycle delegates
  handleWsOpen: (ws: WebSocket) => void;
  handleWsMessage: (ws: WebSocket, raw: unknown) => void;
  handleWsClose: (ws: WebSocket) => void;
};
