import { existsSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import type { ConversationListItem } from "../../conversation-cache";
import { CLAUDE_CODE_PROVIDER, isProviderResumable } from "../../providers";
import type {
  SessionListQuery,
  SessionSortKey,
  SortOrder as SessionSortOrder,
  SessionStatus,
} from "../../types";

// Classify whether a conversation can be resumed from the project directory
// (cwd) the session ran in. Shared by the detail handler and the
// resumable-session shape. A conversation's JSONL parses fine even when its
// cwd is gone, so callers still serve the full history — this only flags that
// resume would fail and why. Returns optional meta fields older clients
// ignore: cwd exists → resumable; gone → not resumable, with a
// worktree-specific reason when the path was a git worktree (now removed).
export function classifyResumability(cwd: string | null | undefined): {
  resumable: boolean;
  unavailable_reason?: "path_missing" | "worktree_removed";
} {
  if (!cwd) return { resumable: true };
  if (existsSync(cwd)) return { resumable: true };
  const ranInWorktree = /\/\.worktrees\//.test(cwd) || /\/\.claude\/worktrees\//.test(cwd);
  return {
    resumable: false,
    unavailable_reason: ranInWorktree ? "worktree_removed" : "path_missing",
  };
}

export function conversationToResumableSession(c: ConversationListItem) {
  const availability = classifyResumability(c.projectPath);
  const provider = c.provider ?? CLAUDE_CODE_PROVIDER;
  return {
    type: "conversation" as const,
    id: c.id,
    conversationId: c.id,
    status: "on_hold" as const,
    // A cached conversation with no process behind it. Distinguishes "nobody is
    // running this" from an external session that IS live (ownership "external").
    // Match the rehydrated branch of managedToResponse: same conceptual state
    // ("resumable, no live process") must produce the same wire shape (#438).
    ownership: "historical" as const,
    lifecycle: "resumable" as const,
    lifecycleSource: "reconcile" as const,
    ptyAttached: false,
    projectId: c.projectId ?? undefined,
    projectPath: c.projectPath ?? "",
    projectName: c.projectName ?? "",
    branch: c.branch ?? undefined,
    lastOutput: "",
    elapsedMs: 0,
    promptCount: c.messageCount,
    startedAt: c.lastActivity,
    completedAt: null,
    lastActivityAt: c.lastActivity,
    ...(c.title != null && { sessionName: c.title }),
    ...(c.model != null && { model: c.model }),
    ...(c.account != null && { account: c.account }),
    messageCount: c.messageCount,
    ...(c.preview != null && { preview: c.preview }),
    ...(c.firstMessage != null && { firstMessageText: c.firstMessage }),
    ...(c.lastMessage != null && { lastMessageText: c.lastMessage }),
    filePath: c.filePath,
    provider,
    resumable: isProviderResumable(provider, availability.resumable),
    ...(availability.unavailable_reason && {
      unavailable_reason: availability.unavailable_reason,
    }),
  };
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function writeHonoResponse(honoRes: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  honoRes.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(honoRes.status, headers);
  if (honoRes.body) {
    const reader = honoRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}

export function intParam(url: URL, name: string, defaultValue: number): number {
  const val = url.searchParams.get(name);
  if (!val) return defaultValue;
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

const VALID_SORT_KEYS: SessionSortKey[] = ["startedAt", "lastActivityAt", "projectName", "status"];
const VALID_ORDERS: SessionSortOrder[] = ["asc", "desc"];
const VALID_STATUSES: SessionStatus[] = ["running", "waiting_input", "idle"];

const SESSIONS_DEFAULT_LIMIT = 200;
const SESSIONS_MAX_LIMIT = 500;

export type ParsedSessionListQuery = { query: SessionListQuery } | { error: string };

export function parseSessionListQuery(url: URL): ParsedSessionListQuery {
  const limitRaw = url.searchParams.get("limit");
  let limit = SESSIONS_DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > SESSIONS_MAX_LIMIT) {
      return { error: `limit must be 1..${SESSIONS_MAX_LIMIT}` };
    }
    limit = n;
  }

  const sortByRaw = url.searchParams.get("sortBy") ?? "startedAt";
  if (!VALID_SORT_KEYS.includes(sortByRaw as SessionSortKey)) {
    return { error: `sortBy must be one of ${VALID_SORT_KEYS.join(",")}` };
  }
  const sortBy = sortByRaw as SessionSortKey;

  const orderRaw = url.searchParams.get("order") ?? "desc";
  if (!VALID_ORDERS.includes(orderRaw as SessionSortOrder)) {
    return { error: `order must be asc or desc` };
  }
  const order = orderRaw as SessionSortOrder;

  const statusRaw = url.searchParams.get("status");
  let status: SessionStatus[] | undefined;
  if (statusRaw) {
    const parts = statusRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      if (!VALID_STATUSES.includes(p as SessionStatus)) {
        return { error: `status entry "${p}" is invalid` };
      }
    }
    status = parts as SessionStatus[];
  }

  const cursor = url.searchParams.get("cursor") ?? undefined;

  return { query: { limit, sortBy, order, status, cursor } };
}

export function readBody(req: IncomingMessage): Promise<any> {
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
