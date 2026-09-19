import { getLogger } from "../../logger";
import type { ManagedSession } from "../../types";
import type { ExpoPushMessage, ExpoPushSender } from "./expoPushSender";

/**
 * "Your turn" notifications.
 *
 * The away-from-desk workflow depends on one moment: the agent finished and is
 * waiting for the user, who put the phone down expecting to be told. This is
 * the module that tells them.
 *
 * Hooked to `onStatusChange` in server.ts for the same reason
 * LiveActivityNotifier is — it is the one funnel every status transition passes
 * through, for both the Claude and Codex runners, so the three `markReady`
 * detectors (prompt-marker, screen-marker, timeout fallback) are all covered
 * without knowing about any of them.
 *
 * Per-turn, not per-status: a turn opens on `waiting_input → running` (the user
 * sent a prompt) and the notification fires on the matching
 * `running → waiting_input`. A session's very first `waiting_input` — boot or
 * resume ready, with no prior turn — opens nothing, so starting a session never
 * notifies the user about the session they just started.
 *
 * Always notifies for a closed turn, including when a WebSocket client is still
 * subscribed. Suppression-while-watched used to skip those pushes as noise when
 * the phone was on the session screen; that also silenced the phone when a
 * desktop browser (or a second device) was subscribed, which is worse than a
 * duplicate banner.
 */

const log = getLogger("expo-push");

/**
 * The payload, and why it is this thin.
 *
 * It says *which* session wants attention, never *what* the agent said. The
 * published privacy policy states notification payloads exclude prompts,
 * terminal output, credentials and conversation content, so `lastOutput` (raw
 * PTY output) and `sessionName` (derived from the user's first message) are
 * both deliberately absent — carrying them is what made the Live Activity
 * payload diverge from that text (RonenMars/threadbase-mobile#636).
 *
 * `projectName` and `sessionId` stay: mobile needs the session id to route the
 * tap, and a notification that cannot say which project it is about is not
 * actionable.
 *
 * There is no `serverId` here on purpose. Which server the app files this one
 * under is per registered token, so `ExpoPushSender` adds it per recipient.
 * The streamer's own hostname is not a substitute: the app keys servers by a
 * hash of their URL and cannot resolve a hostname.
 */
export function waitingInputMessage(session: ManagedSession): ExpoPushMessage {
  return {
    title: session.projectName || "Threadbase",
    body: "Waiting for your input",
    data: { sessionId: session.id },
  };
}

export class WaitingInputNotifier {
  /** Sessions with a turn the user started that has not yet been answered. */
  private openTurn = new Set<string>();

  constructor(private readonly sender: ExpoPushSender) {}

  /**
   * React to a session status change.
   *
   * Fire-and-forget by design: a push must never delay or fail a session
   * transition, so this returns a promise the caller may ignore and every error
   * is logged rather than propagated.
   */
  async onStatusChange(session: ManagedSession, previousStatus?: string): Promise<void> {
    try {
      if (session.status === "running") {
        if (previousStatus === "waiting_input") this.openTurn.add(session.id);
        return;
      }
      if (session.status !== "waiting_input") {
        // idle: the PTY is gone, so any open turn ended without a prompt.
        this.openTurn.delete(session.id);
        return;
      }

      // Delete-as-test: no open turn means boot/resume ready, or a repeat
      // emit of a status we have already notified for. Either way the user is
      // not owed a second notification for one turn.
      if (!this.openTurn.delete(session.id)) return;

      const outcome = await this.sender.send(waitingInputMessage(session));
      if (outcome.attempted > 0) {
        log.info("expo_push.waiting_input", {
          event: "expo_push.waiting_input",
          sessionId: session.id,
          ...outcome,
        });
      }
    } catch (err) {
      log.error("expo_push.notify_failed", {
        event: "expo_push.notify_failed",
        sessionId: session.id,
        status: session.status,
        err: String(err),
      });
    }
  }
}
