export {
  type AgentClient,
  type AgentClientOpts,
  createAgentClient,
} from "./agent/agent-client";
// Multi-agent mode surface. Consumed by tb-multi-agent integration tests and
// by any external integrator wiring up the agent pipeline. See
// docs/multi-agent-mode.md for operator-facing context.
export { type AgentConfig, readAgentConfig } from "./agent/agent-config";
export {
  type AppendArgs,
  type ConversationWriter,
  createConversationWriter,
} from "./agent/conversation-writer";
export { createProgressDedupeLRU, type ProgressDedupeLRU } from "./agent/dedupe";
export { createProgressRoutes } from "./api/routes/progress.routes";
export { generateApiKey, loadOrCreateApiKey, validateApiKey } from "./auth";
export type { DbConfig } from "./db";
export { createPool, getDbConfig, isDbEnabled, maskConnectionString } from "./db";
export { discoverClaudeProcesses } from "./process-discovery";
export { PTYManager } from "./pty-manager";
export { StreamerServer } from "./server";
export { ConversationWatcher } from "./services/conversations/conversationWatcher";
export { SessionStore } from "./session-store";
export * from "./types";
export { WSHub } from "./ws-hub";
