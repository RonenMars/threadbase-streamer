import type { Conversation } from "@threadbase-sh/scanner";
import { existsSync, watch as fsWatch, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import type { ConversationCache } from "./conversation-cache";
import type { CacheMetadataRepository } from "./db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "./db/repositories/conversations.repository";
import type { ManagedSessionsRepository } from "./db/repositories/managed-sessions.repository";
import type { ProjectsRepository } from "./db/repositories/projects.repository";
import type { SessionsRepository } from "./db/repositories/sessions.repository";
import type { LiveSessionManager } from "./live-session-manager";
import { getLogger } from "./logger";
import type { ScannerManager } from "./scanner-manager";
import type { ConversationWatcher } from "./services/conversations/conversationWatcher";
import type { SessionStore } from "./session-store";
import type { WSHub } from "./ws-hub";

/**
 * Everything SessionWatchers reads from the server. Collaborators constructed
 * once in the server constructor are passed by reference; the ones opened
 * during listen() (and rebound by the integrity monitor's reset-and-rescan) are
 * thunks, for the same reason ApiDeps passes `cache: () => ConversationCache | null`.
 *
 * `broadcastConversationLines` / `findConversationByUuid` / `ptyAttachedIds`
 * stay late-bound calls back into the server rather than moved code: they are
 * server methods with their own dependencies (and tests spy on them).
 */
export type SessionWatchersDeps = {
  ptyManager: LiveSessionManager;
  sessionStore: SessionStore;
  wsHub: WSHub;
  fileWatcher: ConversationWatcher;
  /** sessionId → JSONL filePath. Owned by the server; mutated in place here. */
  sessionFileMap: Map<string, string>;
  scannerManager: ScannerManager;
  codexRoots: string[];
  cache: () => ConversationCache | null;
  projectsRepo: () => ProjectsRepository | null;
  conversationsRepo: () => ConversationsRepository | null;
  sessionsRepo: () => SessionsRepository | null;
  cacheMetadataRepo: () => CacheMetadataRepository | null;
  managedSessionsRepo: () => ManagedSessionsRepository | null;
  findConversationByUuid: (uuid: string) => Promise<Conversation | null>;
  broadcastConversationLines: (sessionId: string, lines: string[]) => void;
  ptyAttachedIds: () => Set<string>;
};

/**
 * Binds a live session to the transcript file its provider writes: finds the
 * JSONL (Claude) or rollout (Codex), starts the tail watcher, replays whatever
 * was written before the watcher attached, and links the session to its project.
 *
 * Extracted from StreamerServer so watcher work stops editing the server file
 * (see docs/plans/2026-07-12-server-ts-split.md, PR 5).
 */
export class SessionWatchers {
  private log = getLogger("server");

  constructor(private deps: SessionWatchersDeps) {}

  // ─── Project linking ─────────────────────────────────────────────

  linkSessionToProject(sessionId: string, projectPath: string, filePath: string): void {
    const projectsRepo = this.deps.projectsRepo();
    const conversationsRepo = this.deps.conversationsRepo();
    const sessionsRepo = this.deps.sessionsRepo();
    const cache = this.deps.cache();
    if (!projectsRepo || !conversationsRepo || !sessionsRepo || !cache) {
      return;
    }
    try {
      const project = projectsRepo.upsertProjectByPath(projectPath, {
        lastConversationId: sessionId,
        lastConversationCreatedAt: new Date().toISOString(),
      });
      // The conversation row may not exist yet (Claude is still writing the
      // JSONL). Best-effort: only link if the row is present.
      if (cache.hasConversation(sessionId)) {
        conversationsRepo.updateConversationProjectId({
          conversationId: sessionId,
          projectId: project.id,
        });
      }
      sessionsRepo.updateSessionProjectId({
        sessionId,
        projectId: project.id,
      });
      const cacheMetadataRepo = this.deps.cacheMetadataRepo();
      if (cacheMetadataRepo) {
        cacheMetadataRepo.setCacheMetadata("last_conversation_id", sessionId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`[projects] failed to link session to project: ${message}`, {
        event: "session.project_link_failed",
        sessionId,
        projectPath,
        filePath,
        error: message,
      });
    }
  }

  // ─── File Watcher Wiring ─────────────────────────────────────────

  // `historyId` is the id the provider filed the history under, which for a
  // fresh Codex session is its rollout id rather than our placeholder. The map
  // stays keyed by `sessionId` — that is what broadcasts resolve against.
  async watchConversationFile(sessionId: string, historyId = sessionId): Promise<void> {
    try {
      const conversation = await this.deps.findConversationByUuid(historyId);
      if (conversation?.filePath) {
        this.deps.sessionFileMap.set(sessionId, conversation.filePath);
        this.deps.fileWatcher.watch(conversation.filePath);
      }
    } catch {
      // Best-effort: if we can't find the JSONL file, raw terminal output still works
    }
  }

  // Read just the `sessionId` field from a JSONL's first line, used by the
  // watchForJsonl fallback to confirm a candidate file's identity before
  // binding it. Reads only up to the first newline so a large actively-written
  // file isn't slurped in full.
  readFirstLineSessionId(filePath: string): string | null {
    try {
      const content = readFileSync(filePath, "utf8");
      const nl = content.indexOf("\n");
      const firstLine = nl === -1 ? content : content.slice(0, nl);
      if (!firstLine.trim()) return null;
      const obj = JSON.parse(firstLine);
      return typeof obj.sessionId === "string" ? obj.sessionId : null;
    } catch {
      return null;
    }
  }

  // Watch the project directory for the JSONL file Claude creates for sessionId.
  // Once found, wire up structured event streaming. No rekeying needed — the UUID
  // was passed to Claude via --session-id so the filename matches from the start.
  watchForJsonl(sessionId: string, projectPath: string): void {
    const encoded = projectPath.replace(/[/\\:.]/g, "-");
    const projectsDir = join(homedir(), ".claude", "projects", encoded);
    const expectedFile = `${sessionId}.jsonl`;
    const filePath = join(projectsDir, expectedFile);
    const deadline = Date.now() + 120_000;

    let watcher: ReturnType<typeof fsWatch> | null = null;
    const cleanup = () => {
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
    };

    const tryWire = () => {
      if (!this.deps.ptyManager.hasSession(sessionId)) {
        cleanup();
        return;
      }
      if (Date.now() > deadline) {
        cleanup();
        return;
      }

      // Primary: Claude named the file after the session UUID
      let resolvedFilePath = existsSync(filePath) ? filePath : null;

      // Fallback: the `${sessionId}.jsonl` file hasn't appeared yet. Only bind a
      // candidate whose identity actually matches this session — its filename
      // stem OR its first-line `sessionId` field must equal our session id.
      // Claude 'resume' APPENDS to the SAME file with the SAME sessionId
      // (observed on Claude Code v2.1.215); the previous "resume writes a NEW
      // UUID file" assumption let this bind whichever JSONL was most recently
      // touched — capturing an actively-written FOREIGN conversation and
      // re-broadcasting its whole transcript under our session id. mtime is now
      // only a tiebreaker among already-matching candidates.
      if (!resolvedFilePath && existsSync(projectsDir)) {
        try {
          const now = Date.now();
          const match = readdirSync(projectsDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ f, mtime: statSync(join(projectsDir, f)).mtimeMs }))
            .filter(({ mtime }) => now - mtime < 5_000)
            .filter(
              ({ f }) =>
                basename(f, ".jsonl") === sessionId ||
                this.readFirstLineSessionId(join(projectsDir, f)) === sessionId,
            )
            .sort((a, b) => b.mtime - a.mtime)[0];
          if (match) resolvedFilePath = join(projectsDir, match.f);
        } catch {
          /* ignore */
        }
      }

      if (!resolvedFilePath) return;

      cleanup();
      this.deps.sessionFileMap.set(sessionId, resolvedFilePath);

      // Broadcast any lines already written before the watcher started — Claude
      // can finish writing the JSONL in the same tick as the watcher wires up,
      // so chokidar won't emit a change event for those lines. Dump BEFORE
      // starting the watcher: fileWatcher.watch() seeds its byte offset at the
      // file's current size, so seeding before the dump makes the next append
      // re-ship every dumped line (double broadcast). Seeding after the dump
      // means the watcher starts at the post-dump EOF.
      try {
        const existing = readFileSync(resolvedFilePath, "utf8").split("\n").filter(Boolean);
        if (existing.length > 0) {
          this.deps.broadcastConversationLines(sessionId, existing);
        }
      } catch {
        /* ignore — file may not be readable yet; watcher will catch future writes */
      }
      this.deps.fileWatcher.watch(resolvedFilePath);

      this.deps.scannerManager.markStaleOrDrop();
      this.linkSessionToProject(sessionId, projectPath, resolvedFilePath);
      this.deps.cache()?.markAsStreamer(sessionId);
      this.log.info(
        `[startFresh] wired JSONL for ${sessionId}`,
        { event: "session.jsonl_wired", sessionId, filePath: resolvedFilePath },
        "pino",
      );
    };

    tryWire();
    if (this.deps.sessionFileMap.has(sessionId)) return; // already found

    try {
      require("fs").mkdirSync(projectsDir, { recursive: true });
      watcher = fsWatch(projectsDir, tryWire);
      watcher.on("error", cleanup);
    } catch {
      // fs.watch not available (e.g. in tests), ignore
    }
  }

  // Codex-equivalent of watchForJsonl(). Differs because Codex has no
  // filename-encoded session id (it assigns its own persisted id) and its
  // rollout files live under a date-nested directory
  // (~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl) that Codex creates
  // itself — it may not exist yet when this function is first called, so we
  // poll rather than fs.watch a not-yet-existent directory. Per Phase 0
  // findings, the rollout file appears within ~1s of process spawn (after
  // any directory-trust gate is cleared), well before any user input.
  watchForCodexRollout(sessionId: string, projectPath: string): void {
    const deadline = Date.now() + 120_000;
    const now = new Date();
    const dateDir = join(
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );

    // When this placeholder session started. Used to reject a stale same-cwd
    // rollout that Codex wrote before this session launched — the cwd match
    // alone can't tell a fresh rollout from a seconds-old one. 5s of slack
    // absorbs clock skew between our clock and Codex's session_meta timestamp.
    const sessionStartedAtMs =
      (this.deps.sessionStore.getManaged(sessionId)?.startedAt?.getTime() ?? Date.now()) - 5_000;

    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (intervalHandle) clearInterval(intervalHandle);
      intervalHandle = null;
    };

    // Read a candidate file's session_meta first line; accept only if its cwd
    // matches this session's projectPath and it was created at/after this
    // session started. Guards against picking up an unrelated concurrent Codex
    // session's rollout, or a stale same-cwd rollout from an earlier run, in
    // the same date-nested directory. Returns { id, createdAtMs } or null.
    const matchesProjectPath = (
      candidatePath: string,
    ): { id: string; createdAtMs: number } | null => {
      try {
        const firstLine = readFileSync(candidatePath, "utf8").split("\n", 1)[0];
        if (!firstLine) return null;
        const parsed = JSON.parse(firstLine);
        if (parsed?.type !== "session_meta") return null;
        const payload = parsed.payload ?? {};
        if (payload.cwd !== projectPath) return null;
        if (typeof payload.id !== "string") return null;
        // payload.timestamp is Codex's session-creation time; fall back to the
        // outer envelope timestamp if absent.
        const createdIso = payload.timestamp ?? parsed.timestamp;
        const createdAtMs = typeof createdIso === "string" ? Date.parse(createdIso) : Number.NaN;
        if (Number.isNaN(createdAtMs) || createdAtMs < sessionStartedAtMs) return null;
        return { id: payload.id, createdAtMs };
      } catch {
        return null;
      }
    };

    const tryWire = () => {
      if (!this.deps.ptyManager.hasSession(sessionId)) {
        cleanup();
        return;
      }
      if (Date.now() > deadline) {
        cleanup();
        return;
      }

      // Codex ids already bound to another live placeholder — never bind two
      // placeholders to the same rollout (e.g. two Codex sessions started in
      // the same project inside the mtime window).
      const boundElsewhere = new Set(
        this.deps.sessionStore
          .listManaged()
          .filter((s) => s.id !== sessionId && s.boundConversationId != null)
          .map((s) => s.boundConversationId as string),
      );

      for (const root of this.deps.codexRoots) {
        const sessionsDir = join(root, dateDir);
        if (!existsSync(sessionsDir)) continue;

        let candidateFiles: string[];
        try {
          candidateFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }

        const nowMs = Date.now();
        const recentCandidates = candidateFiles
          .map((f) => ({ f, mtime: statSync(join(sessionsDir, f)).mtimeMs }))
          .filter(({ mtime }) => nowMs - mtime < 10_000)
          .sort((a, b) => b.mtime - a.mtime);

        for (const { f } of recentCandidates) {
          const candidatePath = join(sessionsDir, f);
          const match = matchesProjectPath(candidatePath);
          if (!match) continue;
          if (boundElsewhere.has(match.id)) continue;
          const codexSessionId = match.id;

          cleanup();
          this.deps.sessionStore.updateManaged(sessionId, {
            boundConversationId: codexSessionId,
          });
          // Durably too: after a restart the registry row is the only place
          // this binding survives, and it is the only id `codex resume` accepts.
          try {
            this.deps.managedSessionsRepo()?.recordBinding(sessionId, codexSessionId);
          } catch (err) {
            this.log.warn("[registry] failed to record Codex rollout binding", {
              event: "registry.binding_write_failed",
              sessionId,
              err,
            });
          }

          // Wire the bound rollout into the live update path: tail it for
          // structured events and replay anything already written before the
          // watcher attached (mirrors watchForJsonl()). Without this the bound
          // Codex JSONL is never live-streamed to clients.
          this.deps.sessionFileMap.set(sessionId, candidatePath);
          this.deps.fileWatcher.watch(candidatePath);
          try {
            const existing = readFileSync(candidatePath, "utf8").split("\n").filter(Boolean);
            if (existing.length > 0) {
              this.deps.broadcastConversationLines(sessionId, existing);
            }
          } catch {
            /* ignore — file may not be readable yet; watcher will catch future writes */
          }

          this.deps.scannerManager.markStaleOrDrop();
          this.linkSessionToProject(sessionId, projectPath, candidatePath);
          this.deps.cache()?.markAsStreamer(sessionId);

          // Push the binding to subscribers now — the async discovery means the
          // session_update at start time carried no boundConversationId.
          const resp = this.deps.sessionStore.get(sessionId, this.deps.ptyAttachedIds());
          if (resp) {
            this.deps.wsHub.broadcast({ type: "session_update", session: resp });
          }

          this.log.info(
            `[startFresh] bound Codex rollout for ${sessionId}`,
            {
              event: "session.codex_rollout_bound",
              sessionId,
              boundConversationId: codexSessionId,
              filePath: candidatePath,
            },
            "pino",
          );
          return;
        }
      }
    };

    tryWire();
    if (!intervalHandle && Date.now() <= deadline) {
      // Only keep polling if tryWire() didn't already find + cleanup() the match.
      const alreadyBound =
        this.deps.sessionStore.getManaged(sessionId)?.boundConversationId != null;
      if (!alreadyBound) {
        intervalHandle = setInterval(tryWire, 250);
      }
    }
  }
}
