import type { IncomingMessage, ServerResponse } from "http";
import type { WebSocket } from "ws";
import type { AgentClient } from "../../agent/agent-client";
import type { AgentConfig } from "../../agent/agent-config";
import type { ConversationWriter } from "../../agent/conversation-writer";
import type { ClaudeFlagValues, FlagDefinition } from "../../claude-flags";
import type { ConversationCache } from "../../conversation-cache";
import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import type { DevicesRepository } from "../../db/repositories/devices.repository";
import type { ManagedSessionsRepository } from "../../db/repositories/managed-sessions.repository";
import type { ProjectsRepository } from "../../db/repositories/projects.repository";
import type { PushRepository } from "../../db/repositories/push.repository";
import type { SessionsRepository } from "../../db/repositories/sessions.repository";
import type { RuntimeStore } from "../../db/runtime-store";
import type { E2eeContext } from "../../e2ee/context";
import type {
  FeatureFlagDefinition,
  FeatureFlagId,
  FeatureFlagSource,
  ResolvedFeatureFlags,
} from "../../feature-flags";
import type { LiveSessionManager } from "../../live-session-manager";
import type { CacheIntegrityMonitor } from "../../services/cache-integrity/cacheIntegrityMonitor";
import type { HostPressureMonitor } from "../../services/host-pressure/hostPressure";
import type { Principal } from "../../services/security/capabilities";
import type { ReconcileVerdict } from "../../services/sessions/reconcileSessions";
import type { SessionStore } from "../../session-store";
import type { WSHub } from "../../ws-hub";

export type ApiDeps = {
  apiKey: string;
  localNoAuth: boolean;
  logMenubarRequests: boolean;
  rotateApiKey: () => { newKey: string; persisted: boolean };
  claudeFlagsConfig: () => {
    registry: readonly FlagDefinition[];
    values: ClaudeFlagValues;
    extraArgs: string | null;
    persisted: boolean;
  };
  setClaudeFlagsConfig: (
    values: ClaudeFlagValues,
    extraArgs: string | undefined,
  ) => { values: ClaudeFlagValues; extraArgs: string | null; persisted: boolean };
  featureFlagsConfig: () => {
    registry: readonly FeatureFlagDefinition[];
    values: ResolvedFeatureFlags;
    sources: Record<FeatureFlagId, FeatureFlagSource>;
  };
  publicUrl: string | null;
  browseRoot: string | null;
  browserCors: string | undefined;
  ptyManager: LiveSessionManager;
  sessionStore: SessionStore;
  wsHub: WSHub;
  cache: () => ConversationCache | null;
  cacheMonitor: () => CacheIntegrityMonitor | null;
  hostPressureMonitor: () => HostPressureMonitor | null;
  /** Push registration + delivery state (C7). Null when the cache DB is unavailable. */
  pushRepo: () => PushRepository | null;
  /**
   * Whether Live Activity push is actually running on this server — the same
   * fact the boot log reports as `live_activity.enabled`. Asked of the server
   * rather than re-derived from the environment, because APNs credentials alone
   * do not enable it: the sender is only wired when the token store opened too.
   */
  liveActivityPushEnabled: () => boolean;

  /** Paired-device registry (C5). Null when the cache DB is unavailable. */
  devicesRepo: () => DevicesRepository | null;
  projectsRepo: () => ProjectsRepository | null;
  conversationsRepo: () => ConversationsRepository | null;
  sessionsRepo: () => SessionsRepository | null;
  cacheMetadataRepo: () => CacheMetadataRepository | null;
  /** Authoritative session registry (~/.threadbase/runtime.db). Null when it failed to open. */
  runtimeStore: () => RuntimeStore | null;
  /** Rows of that registry. Null when it failed to open. */
  managedSessionsRepo: () => ManagedSessionsRepository | null;
  /** This boot's reconcile verdicts, by session id. Empty before it has run. */
  sessionVerdicts: () => Map<string, ReconcileVerdict>;
  ptyAttachedIds: () => Set<string>;
  // Session handler delegates — called by Hono handlers, implemented by StreamerServer
  handleListSessions: (url: URL, res: ServerResponse) => Promise<void>;
  handleSessionsCount: (res: ServerResponse) => void;
  handleGetRecentSessions: (url: URL, res: ServerResponse) => void;
  handleGetSessionNames: (res: ServerResponse) => void;
  handleGetSession: (sessionId: string, res: ServerResponse) => Promise<void>;
  handleGetOutput: (sessionId: string, res: ServerResponse) => void;
  handleSendInput: (sessionId: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleSendAnswer: (sessionId: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handlePromptAnswer: (
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  handlePermissionAnswer: (
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  handleCancel: (sessionId: string, res: ServerResponse) => void;
  handleStopSession: (sessionId: string, res: ServerResponse) => Promise<void>;
  handleSetSessionName: (
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  handleSetSessionModel: (
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  handleSetSessionEffort: (
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  handleUploadFile: (sessionId: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleAdopt: (sessionId: string, res: ServerResponse) => Promise<void>;
  handleFork: (sessionId: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
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
  handleSearchTarget: (id: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleListProjects: (url: URL, res: ServerResponse) => void;
  handleGetPopularProjects: (url: URL, res: ServerResponse) => void;
  handleGetProjectSummaries: (url: URL, res: ServerResponse) => void;
  handlePairStart: (res: ServerResponse) => void;
  handlePairExchange: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleBrowse: (url: URL, res: ServerResponse) => Promise<void>;
  handleMkdir: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  // WebSocket lifecycle delegates. `principal` is captured at the upgrade and
  // is what lets a frame be authorized; null means the request took a bypass
  // path (today only --local-no-auth) and carries that path's full authority.
  /**
   * `context` is present only for a socket that presented a valid ticket. Its
   * absence is the legacy plaintext path, which must keep working (§8, dual
   * paths).
   */
  handleWsOpen: (ws: WebSocket, context?: E2eeContext) => void;
  handleWsMessage: (ws: WebSocket, raw: unknown, principal: Principal | null) => void;
  handleWsClose: (ws: WebSocket) => void;
  // Multi-agent mode. Null when MULTI_AGENT_FLOW is OFF.
  agentClient: AgentClient | null;
  conversationWriter: ConversationWriter | null;
  agentConfig: AgentConfig;
};
