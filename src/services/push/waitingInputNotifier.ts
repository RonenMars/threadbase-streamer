import { getLogger } from "../../logger";
import type { ManagedSession } from "../../types";
import type { ExpoPushContent, ExpoPushSender } from "./expoPushSender";
import { type AttentionKind, attentionBody, attentionTitle } from "./notificationCopy";
import type { PushEvent } from "./notificationPrefs";

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
 * The same notifier covers the agent stopping mid-turn for the user — a
 * permission gate or an AskUserQuestion menu. Those keep the turn open (Claude
 * holds its turn signal across them), so without a push of their own an
 * away-from-desk user would never learn the agent was blocked on them. One
 * push per prompt: repaints and cursor moves of the same prompt are not new.
 *
 * A session that dies at birth — the process exits at once, or Codex refuses to
 * start — gets one push of its own, since otherwise a user who started it and
 * walked away sees nothing. The text never carries `failureReason`, which
 * embeds project paths. Codex usage-limit screens are not this: they already
 * arrive as a permission prompt.
 *
 * "Finished" is only sent for an end the provider itself signalled
 * (`statusSource: "turn-signal"`), and only once it has held for
 * TURN_DONE_SETTLE_MS. Every runner also settles a turn by guessing — a
 * prompt marker that stays painted all turn, a submit-stale or boot timer —
 * and each of those guesses fired "finished" one to two seconds after the user
 * sent a message, while the agent was still working (#962). A guessed end now
 * sends nothing: a missing "finished" costs a glance at the app, a false one
 * teaches the user to ignore the notification that matters.
 *
 * Every push is gated by the receiving device's own preferences, per token, in
 * ExpoPushSender: "waitingInput" for the three kinds that mean the agent needs
 * the user, "sessionFailed" for the failure push.
 *
 * Always notifies for a closed turn, including when a WebSocket client is still
 * subscribed. Suppression-while-watched used to skip those pushes as noise when
 * the phone was on the session screen; that also silenced the phone when a
 * desktop browser (or a second device) was subscribed, which is worse than a
 * duplicate banner.
 */

const log = getLogger("expo-push");

/**
 * How long a turn end must hold before "finished" is sent. Anything that takes
 * the session back to `running` or opens a gate inside this window cancels it,
 * so a turn that briefly settles and resumes never reports itself done.
 */
export const TURN_DONE_SETTLE_MS = 2_000;

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
export function waitingInputMessage(
  session: Pick<ManagedSession, "id" | "projectName" | "provider">,
  kind: AttentionKind = "turn_done",
): ExpoPushContent {
  return (locale) => ({
    title: attentionTitle(kind, session.projectName),
    body: attentionBody(kind, session.provider, locale),
    data: { sessionId: session.id, kind },
    sound: "default",
    priority: "high",
    // One stack per session, and the newest state replaces the older banner:
    // "needs your go-ahead" is stale the moment the turn finishes.
    threadId: session.id,
    collapseId: session.id,
    tag: session.id,
  });
}

export class WaitingInputNotifier {
  /** Sessions with a turn the user started that has not yet been answered. */
  private openTurn = new Map<string, number>();
  /** Sessions with a prompt (gate or question) already pushed and still open. */
  private openPrompt = new Set<string>();
  /** Sessions that have reached a prompt at least once, so they did start. */
  private readySeen = new Set<string>();
  /**
   * Sessions whose going idle has already been looked at, so a repeat emit is
   * not read as a second death. Cleared when the session is alive again.
   */
  private idleHandled = new Set<string>();
  /** A "finished" push waiting out TURN_DONE_SETTLE_MS, per session. */
  private pendingDone = new Map<string, NodeJS.Timeout>();

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
      // Leaving waiting_input supersedes a "finished" that has not gone out yet.
      // A repeat waiting_input emit does not: it is the same turn end.
      if (session.status !== "waiting_input") this.cancelDone(session, previousStatus);
      if (session.status === "running") {
        this.idleHandled.delete(session.id);
        if (previousStatus === "waiting_input") this.openTurn.set(session.id, Date.now());
        this.logDecision(
          session,
          previousStatus,
          previousStatus === "waiting_input" ? "turn_open" : "running_no_turn",
        );
        return;
      }
      this.openPrompt.delete(session.id);
      if (session.status !== "waiting_input") {
        // idle: the PTY is gone, so any open turn ended without a prompt.
        this.openTurn.delete(session.id);
        // "Could not start" means it never got as far as a prompt. A Codex
        // session that hit a usage limit keeps its failureReason and goes idle
        // when the user closes it much later — that is not a failed start.
        const neverReady = !this.readySeen.delete(session.id);
        const firstIdle = !this.idleHandled.has(session.id);
        this.idleHandled.add(session.id);
        if (firstIdle && neverReady && session.failureReason != null) {
          await this.push(session, "failed");
        }
        return;
      }
      // Alive again (a resume after a failed start), so the next failure counts.
      this.idleHandled.delete(session.id);
      this.readySeen.add(session.id);

      // Delete-as-test: no open turn means boot/resume ready, or a repeat
      // emit of a status we have already notified for. Either way the user is
      // not owed a second notification for one turn.
      const openedAt = this.openTurn.get(session.id);
      if (!this.openTurn.delete(session.id)) {
        this.logDecision(session, previousStatus, "skip_no_open_turn");
        return;
      }

      if (session.statusSource !== "turn-signal") {
        this.logDecision(session, previousStatus, "skip_unconfirmed_end", openedAt);
        return;
      }

      this.logDecision(session, previousStatus, "done_scheduled", openedAt);
      const timer = setTimeout(() => {
        this.pendingDone.delete(session.id);
        this.logDecision(session, previousStatus, "push_turn_done", openedAt);
        void this.push(session, "turn_done").catch((err) => {
          log.error("expo_push.notify_failed", {
            event: "expo_push.notify_failed",
            sessionId: session.id,
            status: session.status,
            err: String(err),
          });
        });
      }, TURN_DONE_SETTLE_MS);
      timer.unref?.();
      this.pendingDone.set(session.id, timer);
    } catch (err) {
      log.error("expo_push.notify_failed", {
        event: "expo_push.notify_failed",
        sessionId: session.id,
        status: session.status,
        err: String(err),
      });
    }
  }

  /**
   * A permission gate or question opened (`open`) or closed on this session.
   * Fire-and-forget like onStatusChange.
   */
  async onPrompt(
    session: Pick<ManagedSession, "id" | "projectName" | "provider">,
    kind: "permission" | "question",
    open: boolean,
  ): Promise<void> {
    try {
      if (!open) {
        this.openPrompt.delete(session.id);
        return;
      }
      if (this.openPrompt.has(session.id)) return;
      this.openPrompt.add(session.id);
      // The agent stopped for the user mid-turn: "needs you" replaces "finished".
      const pending = this.pendingDone.get(session.id);
      if (pending) {
        clearTimeout(pending);
        this.pendingDone.delete(session.id);
      }
      await this.push(session, kind);
    } catch (err) {
      log.error("expo_push.notify_failed", {
        event: "expo_push.notify_failed",
        sessionId: session.id,
        kind,
        err: String(err),
      });
    }
  }

  private cancelDone(session: ManagedSession, previousStatus: string | undefined): void {
    const pending = this.pendingDone.get(session.id);
    if (!pending) return;
    clearTimeout(pending);
    this.pendingDone.delete(session.id);
    this.logDecision(session, previousStatus, "done_cancelled");
  }

  // Why a status change did or did not become a "finished" push (#962).
  // turnAgeMs is submit -> turn end, so a false "finished" shows up as a tiny one.
  private logDecision(
    session: ManagedSession,
    previousStatus: string | undefined,
    decision: string,
    openedAt?: number,
  ): void {
    log.info(`[push.turn_decision] ${session.id.slice(0, 8)} ${decision}`, {
      event: "push.turn_decision",
      sessionId: session.id,
      provider: session.provider,
      previousStatus,
      status: session.status,
      statusSource: session.statusSource,
      decision,
      turnAgeMs: openedAt == null ? undefined : Date.now() - openedAt,
    });
  }

  private async push(
    session: Pick<ManagedSession, "id" | "projectName" | "provider">,
    kind: AttentionKind,
  ): Promise<void> {
    const event: PushEvent = kind === "failed" ? "sessionFailed" : "waitingInput";
    const outcome = await this.sender.send(waitingInputMessage(session, kind), { event });
    if (outcome.attempted > 0 || outcome.suppressed > 0) {
      log.info("expo_push.waiting_input", {
        event: "expo_push.waiting_input",
        sessionId: session.id,
        kind,
        ...outcome,
      });
    }
  }
}
