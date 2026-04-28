import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "./session-store";
import type { ManagedSession } from "./types";

export interface ReconcileResult {
  sessionId: string;
  updates: Partial<ManagedSession>;
}

/**
 * Backfill / repair pass run once at startup, after SessionStore.rehydrate().
 *
 * After a streamer restart, every persisted managed session that was alive when
 * the previous process died is rehydrated with status="running" but no live PTY
 * (PTYManager.sessions starts empty). We mark those as "failed" so the listing
 * reflects reality. We also backfill conversationId from disk for fresh
 * sessions whose UUID was never recorded — see findConversationIdForSession.
 */
export async function reconcileOrphanedSessions(
  sessionStore: SessionStore,
  options: { claudeProjectsRoot?: string; now?: Date } = {},
): Promise<ReconcileResult[]> {
  const claudeProjectsRoot =
    options.claudeProjectsRoot ?? join(homedir(), ".claude", "projects");
  const now = options.now ?? new Date();
  const results: ReconcileResult[] = [];

  for (const session of sessionStore.listManaged()) {
    const updates: Partial<ManagedSession> = {};

    if (session.status === "running" || session.status === "waiting_input") {
      updates.status = "failed";
      updates.completedAt = now;
    }

    if (!session.conversationId) {
      const found = await findConversationIdForSession(session, claudeProjectsRoot);
      if (found) updates.conversationId = found;
    }

    if (Object.keys(updates).length > 0) {
      sessionStore.updateManaged(session.id, updates);
      results.push({ sessionId: session.id, updates });
    }
  }

  return results;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Find the conversation UUID Claude Code generated for a session by scanning
 * its project's JSONL directory and picking the file whose creation time is
 * closest to (and within a day of) session.startedAt.
 *
 * Claude stores conversations at ~/.claude/projects/<encoded>/<UUID>.jsonl,
 * where <encoded> is the absolute project path with "/" and "." replaced by "-".
 * The match is necessarily fuzzy; if two sessions started in the same project
 * within seconds of each other their UUIDs may swap. Acceptable for backfill of
 * orphaned sessions; a real-time write-side capture is the principled fix.
 */
export async function findConversationIdForSession(
  session: Pick<ManagedSession, "projectPath" | "startedAt">,
  claudeProjectsRoot: string,
): Promise<string | null> {
  const encoded = session.projectPath.replace(/[/.]/g, "-");
  const dir = join(claudeProjectsRoot, encoded);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const startMs = session.startedAt.getTime();
  let best: { uuid: string; delta: number } | null = null;

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const uuid = name.slice(0, -".jsonl".length);
    let fileMs: number;
    try {
      const s = await stat(join(dir, name));
      fileMs = s.birthtimeMs || s.ctimeMs || s.mtimeMs;
    } catch {
      continue;
    }
    const delta = Math.abs(fileMs - startMs);
    if (!best || delta < best.delta) best = { uuid, delta };
  }

  return best && best.delta < ONE_DAY_MS ? best.uuid : null;
}
