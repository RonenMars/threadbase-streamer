// src/agent/agent-config.ts
//
// Runtime config for multi-agent mode. Read once at server startup so we don't
// thread env-var lookups through the rest of the codebase.

export interface AgentConfig {
  enabled: boolean;
  temporal: {
    address: string;
    namespace: string;
    taskQueue: string;
  };
  webhook: {
    hmacSecret: string;
    timestampSkewSeconds: number;
  };
  dedupe: {
    perSessionCapacity: number;
  };
  payload: {
    limitBytes: number;
    trajectoryLogBytes: number;
    trajectoryLogTurns: number;
  };
  sessionBusyRetryMs: number;
  conversationsDir: string;
}

const DEFAULTS = {
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "agent-tasks",
  PROGRESS_HMAC_SECRET: "dev-secret-change-me",
  PROGRESS_WEBHOOK_TIMESTAMP_SKEW_SECONDS: "300",
  PROGRESS_DEDUPE_CAPACITY: "1024",
  AGENT_PAYLOAD_LIMIT_BYTES: "1572864", // 1.5 MB — 75% of Temporal's 2 MB ceiling
  AGENT_TRAJECTORY_LOG_BYTES: "512000", // 500 KB
  AGENT_TRAJECTORY_LOG_TURNS: "20", // First turn count for trajectory WARN
  AGENT_SESSION_BUSY_RETRY_MS: "1000",
};

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const enabled = isTruthy(env.MULTI_AGENT_FLOW);
  return {
    enabled,
    temporal: {
      address: env.TEMPORAL_ADDRESS ?? DEFAULTS.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE ?? DEFAULTS.TEMPORAL_NAMESPACE,
      taskQueue: env.TEMPORAL_TASK_QUEUE ?? DEFAULTS.TEMPORAL_TASK_QUEUE,
    },
    webhook: {
      hmacSecret: env.PROGRESS_HMAC_SECRET ?? DEFAULTS.PROGRESS_HMAC_SECRET,
      timestampSkewSeconds: Number(
        env.PROGRESS_WEBHOOK_TIMESTAMP_SKEW_SECONDS ??
          DEFAULTS.PROGRESS_WEBHOOK_TIMESTAMP_SKEW_SECONDS,
      ),
    },
    dedupe: {
      perSessionCapacity: Number(env.PROGRESS_DEDUPE_CAPACITY ?? DEFAULTS.PROGRESS_DEDUPE_CAPACITY),
    },
    payload: {
      limitBytes: Number(env.AGENT_PAYLOAD_LIMIT_BYTES ?? DEFAULTS.AGENT_PAYLOAD_LIMIT_BYTES),
      trajectoryLogBytes: Number(
        env.AGENT_TRAJECTORY_LOG_BYTES ?? DEFAULTS.AGENT_TRAJECTORY_LOG_BYTES,
      ),
      trajectoryLogTurns: Number(
        env.AGENT_TRAJECTORY_LOG_TURNS ?? DEFAULTS.AGENT_TRAJECTORY_LOG_TURNS,
      ),
    },
    sessionBusyRetryMs: Number(
      env.AGENT_SESSION_BUSY_RETRY_MS ?? DEFAULTS.AGENT_SESSION_BUSY_RETRY_MS,
    ),
    // Mirrors ServerConfig.cacheDir's parent — the actual JSONL directory.
    // We read it from env here; the conversation writer takes the resolved
    // value from ServerConfig in Task 9.
    conversationsDir: env.THREADBASE_CONVERSATIONS_DIR ?? "",
  };
}
