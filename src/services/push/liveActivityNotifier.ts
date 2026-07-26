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
  };
}

export class LiveActivityNotifier {
  /**
   * Last status pushed per session.
   *
   * Live Activity pushes are rate-limited by iOS and the surface only renders
   * `running` vs `waiting_input`, so re-pushing an unchanged status is pure
   * budget spend for no visible change. This is what makes the notifier
   * edge-triggered rather than level-triggered.
   */
  private lastPushed = new Map<string, string>();

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
  async onStatusChange(session: ManagedSession): Promise<void> {
    const status = toLiveActivityStatus(session.status);

    try {
      if (!status) {
        // Anything not renderable means the session is no longer live. End the
        // activity and stop tracking it, so a renewal cannot resurrect it.
        await this.endFor(session);
        return;
      }

      if (this.lastPushed.get(session.id) === status) return;

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
      this.lastPushed.set(session.id, status);
      if (outcome.attempted > 0) {
        log.info("live_activity.updated", {
          event: "live_activity.updated",
          sessionId: session.id,
          status,
          ...outcome,
        });
      }
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

  private async endFor(session: ManagedSession): Promise<void> {
    // Carry the last renderable status through the end event: the content state
    // is required by the payload, and `idle` has no encoding mobile understands.
    const lastStatus = this.lastPushed.get(session.id);
    this.lastPushed.delete(session.id);

    const contentState = contentStateForSession({
      session: {
        ...session,
        status: lastStatus === "waiting_input" ? "waiting_input" : "running",
      },
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

  /** Drop cached state for a session, so a resume re-pushes its first status. */
  forget(sessionId: string): void {
    this.lastPushed.delete(sessionId);
  }
}
