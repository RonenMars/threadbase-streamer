import { getLogger } from "../../logger";
import type { ManagedSession } from "../../types";
import {
  type LiveActivityContentState,
  toLiveActivityStatus,
  truncateLastOutput,
} from "./liveActivityContentState";
import type { LiveActivitySender } from "./liveActivitySender";

/**
 * Bridge from the session lifecycle to Live Activity pushes.
 *
 * `onStatusChange` in server.ts is the one funnel every status transition passes
 * through, for both the Claude and Codex runners, so hooking here covers every
 * path rather than one runner's. This module exists to keep that callback a
 * single call and to hold the "which transitions are worth a push" rule in one
 * testable place.
 *
 * Per-turn, not per-session: a turn opens on `waiting_input → running` (the
 * user sent a prompt) and closes on the matching `running → waiting_input`
 * (the response — including sub-agents, invisible to this signal since they
 * run inside the same `running` span — finished). A session's very first
 * `running`, right after spawn with no prior `waiting_input`, opens nothing —
 * that's what keeps a freshly booted or idling session from showing an
 * activity before the user has asked for anything. See
 * docs/guides/live-activity-push.md for the full contract.
 */

const log = getLogger("live-activity");

/**
 * Build the content state mobile decodes.
 *
 * `startedAt` comes from the session's own start and is passed through in epoch
 * milliseconds: iOS renders its own ticking timer from it, so the server must
 * never compute an elapsed value.
 */
export function contentStateForSession(args: {
  session: ManagedSession;
  serverId: string;
  serverLabel?: string;
  /** Overrides the session's own start — used by a renewal to preserve continuity. */
  startedAtOverride?: number | null;
}): LiveActivityContentState | null {
  const status = toLiveActivityStatus(args.session.status);
  // No representation for a non-live status: that case is an `end`, not an
  // update carrying a status mobile has no case for.
  if (!status) return null;

  return {
    sessionId: args.session.id,
    serverId: args.serverId,
    projectName: args.session.projectName,
    status,
    startedAt: args.startedAtOverride ?? args.session.startedAt.getTime(),
    lastOutput: truncateLastOutput(args.session.lastOutput ?? ""),
    ...(args.serverLabel != null && { serverLabel: args.serverLabel }),
    ...(args.session.sessionName != null && { sessionName: args.session.sessionName }),
  };
}

export class LiveActivityNotifier {
  /**
   * Sessions with a currently open (pushed) activity.
   *
   * An activity opens on a `waiting_input → running` edge (the user sent a
   * prompt) and closes on the matching `running → waiting_input` edge (the
   * response, including any sub-agents, finished) — so this set is what makes
   * the notifier per-turn rather than per-session. A session's very first
   * `running` (right after spawn, before any user prompt) has no prior
   * `waiting_input` and therefore no edge, so it never opens an activity —
   * this is what keeps a fresh/idle session from pushing anything.
   */
  private openActivity = new Map<string, { sessionNameSent: boolean }>();

  constructor(
    private readonly sender: LiveActivitySender,
    private readonly serverId: string,
    private readonly serverLabel?: string,
  ) {}

  /**
   * React to a session status change.
   *
   * Fire-and-forget by design: a push must never delay or fail a session
   * transition, so this returns a promise the caller may ignore and every error
   * is logged rather than propagated.
   */
  async onStatusChange(session: ManagedSession, previousStatus?: string): Promise<void> {
    const status = toLiveActivityStatus(session.status);

    try {
      if (!status) {
        // Anything not renderable means the session is no longer live. If a
        // turn was still open (mid-turn PTY death), end it so a renewal can't
        // resurrect it; otherwise there is nothing to close.
        if (this.openActivity.has(session.id)) await this.endFor(session);
        return;
      }

      if (status === "running" && previousStatus === "waiting_input") {
        await this.startTurn(session);
        return;
      }

      if (status === "waiting_input" && previousStatus === "running") {
        // Only a real turn end if one was actually opened — the session's
        // very first waiting_input (boot ready, no prior turn) has none.
        if (this.openActivity.has(session.id)) await this.endFor(session);
        return;
      }

      // Any other same-status re-emit: refresh the name if it has just become
      // available on an already-open turn (the first message races the title
      // derivation, so the name can land after the turn already started).
      await this.maybeSendName(session);
    } catch (err) {
      // A push failure must not surface as a session-transition failure, but it
      // must not vanish either.
      log.error("live_activity.notify_failed", {
        event: "live_activity.notify_failed",
        sessionId: session.id,
        status: session.status,
        err: String(err),
      });
    }
  }

  private async startTurn(session: ManagedSession): Promise<void> {
    const contentState = contentStateForSession({
      session,
      serverId: this.serverId,
      serverLabel: this.serverLabel,
    });
    if (!contentState) return;

    const outcome = await this.sender.send({
      sessionId: session.id,
      event: "update",
      contentState,
    });
    this.openActivity.set(session.id, { sessionNameSent: session.sessionName != null });
    if (outcome.attempted > 0) {
      log.info("live_activity.updated", {
        event: "live_activity.updated",
        sessionId: session.id,
        status: contentState.status,
        ...outcome,
      });
    }
  }

  private async maybeSendName(session: ManagedSession): Promise<void> {
    const open = this.openActivity.get(session.id);
    if (!open || open.sessionNameSent || session.sessionName == null) return;

    const contentState = contentStateForSession({
      session,
      serverId: this.serverId,
      serverLabel: this.serverLabel,
    });
    if (!contentState) return;

    const outcome = await this.sender.send({
      sessionId: session.id,
      event: "update",
      contentState,
    });
    open.sessionNameSent = true;
    if (outcome.attempted > 0) {
      log.info("live_activity.updated", {
        event: "live_activity.updated",
        sessionId: session.id,
        status: contentState.status,
        ...outcome,
      });
    }
  }

  private async endFor(session: ManagedSession): Promise<void> {
    this.openActivity.delete(session.id);

    // Carry the last renderable status through the end event: the content state
    // is required by the payload, and `idle` has no encoding mobile understands.
    const status = toLiveActivityStatus(session.status);
    const contentState = contentStateForSession({
      session: { ...session, status: status ?? "waiting_input" },
      serverId: this.serverId,
      serverLabel: this.serverLabel,
    });
    if (!contentState) return;

    const outcome = await this.sender.end({ sessionId: session.id, contentState });
    if (outcome.attempted > 0) {
      log.info("live_activity.ended", {
        event: "live_activity.ended",
        sessionId: session.id,
        ...outcome,
      });
    }
  }

  /** Drop cached state for a session, so a resume re-opens on its next turn. */
  forget(sessionId: string): void {
    this.openActivity.delete(sessionId);
  }
}
