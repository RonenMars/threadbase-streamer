import { getLogger } from "../../logger";
import type { ManagedSession } from "../../types";
import type { ExpoPushSender } from "./expoPushSender";
import { waitingInputMessage } from "./waitingInputNotifier";

/**
 * Idle-session nudge (#515): a session that has sat in `waiting_input` for
 * longer than the threshold gets ONE push per wait, so a user who backgrounded
 * the app learns the agent is still parked at its prompt.
 *
 * Off by default (`IDLE_NOTIFY_ENABLED`). Composes with, and does not replace,
 * WaitingInputNotifier: it reuses that module's payload builder
 * (`waitingInputMessage`, same `data` shape the "finished" push carries) and
 * the same ExpoPushSender, so per-token preferences, quiet hours, feature
 * gating, `serverId` and dead-token revocation all apply unchanged.
 *
 * Like WaitingInputNotifier it does not suppress while a client is subscribed
 * to the session: a desktop browser left open must not silence the phone.
 *
 * Wait state is in memory and keyed by session id; it resets the moment the
 * session leaves `waiting_input`, so the next wait can notify again. Notified
 * only counts once a send was actually attempted: a wait with no deliverable
 * token (nobody registered yet, all revoked, or preferences/quiet hours muted
 * every device) stays eligible and is retried on the next sweep, so a device
 * that registers mid-wait, or quiet hours that end, still get the nudge.
 */

const log = getLogger("expo-push");

export const IDLE_NOTIFY_DEFAULT_THRESHOLD_MS = 20 * 60_000;
export const IDLE_NOTIFY_DEFAULT_SWEEP_MS = 60_000;
/** A sweep faster than this is a busy loop, not a tuning choice. */
const MIN_SWEEP_MS = 1_000;
/** Bounds the work (and the Expo requests) of one sweep; the rest wait a tick. */
export const MAX_IDLE_NOTIFY_PER_SWEEP = 10;

export interface IdleNotifyConfig {
  enabled: boolean;
  thresholdMs: number;
  sweepMs: number;
}

/** A positive integer of milliseconds at least `min`; anything else is the default. */
function parseMs(raw: string | undefined, fallback: number, min = 1): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

export function parseIdleNotifyConfig(env: NodeJS.ProcessEnv = process.env): IdleNotifyConfig {
  return {
    // Strict opt-in: only an unmistakable "yes" turns it on, a typo leaves it off.
    enabled: ["1", "true", "yes", "on"].includes(
      env.IDLE_NOTIFY_ENABLED?.trim().toLowerCase() ?? "",
    ),
    thresholdMs: parseMs(env.IDLE_NOTIFY_THRESHOLD_MS, IDLE_NOTIFY_DEFAULT_THRESHOLD_MS),
    sweepMs: parseMs(env.IDLE_NOTIFY_SWEEP_MS, IDLE_NOTIFY_DEFAULT_SWEEP_MS, MIN_SWEEP_MS),
  };
}

interface Wait {
  since: number;
  notified: boolean;
}

export class IdleSessionNotifier {
  private readonly waits = new Map<string, Wait>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private readonly sender: Pick<ExpoPushSender, "send">;
  private readonly listSessions: () => ManagedSession[];
  private readonly config: IdleNotifyConfig;
  private readonly now: () => number;

  constructor(opts: {
    sender: Pick<ExpoPushSender, "send">;
    listSessions: () => ManagedSession[];
    config: IdleNotifyConfig;
    now?: () => number;
  }) {
    this.sender = opts.sender;
    this.listSessions = opts.listSessions;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.config.sweepMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.waits.clear();
  }

  /** The status funnel: a wait starts on entering `waiting_input`, ends on leaving it. */
  onStatusChange(session: Pick<ManagedSession, "id" | "status">, _previous?: string): void {
    if (session.status !== "waiting_input") {
      this.waits.delete(session.id);
      return;
    }
    // A repeat emit is the same wait; keep its clock.
    if (!this.waits.has(session.id)) this.waits.set(session.id, this.newWait());
  }

  /** One pass. Never throws; overlapping calls collapse into the running one. */
  async sweep(): Promise<void> {
    if (!this.config.enabled || this.sweeping) return;
    this.sweeping = true;
    try {
      const now = this.now();
      const waiting = new Map<string, ManagedSession>();
      for (const s of this.listSessions()) {
        if (s.status === "waiting_input") waiting.set(s.id, s);
      }
      // Anything no longer waiting (or gone) is a finished wait.
      for (const id of this.waits.keys()) if (!waiting.has(id)) this.waits.delete(id);

      let sent = 0;
      for (const [id, session] of waiting) {
        // First sight of a wait the funnel never reported: the clock starts now.
        const wait = this.waits.get(id) ?? this.newWait();
        this.waits.set(id, wait);
        if (wait.notified || now - wait.since < this.config.thresholdMs) continue;
        if (sent >= MAX_IDLE_NOTIFY_PER_SWEEP) break;
        sent += 1;
        await this.notify(session, wait, now);
      }
    } catch (err) {
      log.error("push.idle_notify_failed", { event: "push.idle_notify_failed", err: String(err) });
    } finally {
      this.sweeping = false;
    }
  }

  private newWait(): Wait {
    return { since: this.now(), notified: false };
  }

  private async notify(session: ManagedSession, wait: Wait, now: number): Promise<void> {
    const idleMinutes = Math.floor((now - wait.since) / 60_000);
    try {
      const outcome = await this.sender.send(
        waitingInputMessage(session, "idle", { idleMinutes }),
        { event: "waitingInput" },
      );
      // A wait that ended during the send is a detached object; marking it is harmless.
      if (outcome.attempted > 0) wait.notified = true;
      log.info("push.idle_notify", {
        event: "push.idle_notify",
        sessionId: session.id,
        idleMinutes,
        ...outcome,
      });
    } catch (err) {
      log.error("push.idle_notify_failed", {
        event: "push.idle_notify_failed",
        sessionId: session.id,
        err: String(err),
      });
    }
  }
}
