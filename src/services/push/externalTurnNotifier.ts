import type { PushRepository } from "../../db/repositories/push.repository";
import { getLogger } from "../../logger";
import type { ProviderName } from "../../providers";
import { transcriptTurnEndAt } from "../sessions/transcriptTurnEnd";
import type { ExpoPushSender } from "./expoPushSender";
import { waitingInputMessage } from "./waitingInputNotifier";

/**
 * Turn-end pushes for an external session (#1265).
 *
 * An external session is a process this streamer did not spawn, so it never
 * passes through `onStatusChange` and `WaitingInputNotifier` cannot see it. What
 * the streamer does see is its transcript, tailed by `ExternalTailManager`, and
 * the transcript says when a turn ended (`transcriptTurnEndAt`, the same parser
 * the managed runners use as a second signal, #1048).
 *
 * A device is told only if it subscribed to that conversation
 * (`push_tokens` row + `external_session_subscriptions`); nobody else is, which
 * is why this sends with `only` rather than fanning out like the managed push.
 *
 * Only "finished" exists here. A permission gate or question is on a screen the
 * streamer cannot read, so there is nothing to push for them.
 *
 * Fire-and-forget like its sibling: every error is logged, never thrown into the
 * tail path that feeds it.
 */

const log = getLogger("expo-push");

/**
 * A turn end older than this is a replay (a tail re-read, a batch delivered
 * late), not news. Matches the window in which the tail attaches to a file at
 * all (`EXTERNAL_TAIL_RECENCY_MS`): a turn that ended before that is not one
 * the tail was watching.
 */
export const EXTERNAL_TURN_MAX_AGE_MS = 120_000;

type ConversationMeta = {
  provider: ProviderName;
  projectName: string | null;
  branch: string | null;
};

export class ExternalTurnNotifier {
  /**
   * The latest turn end already pushed, per subscribed conversation. Keyed on
   * the end line's own timestamp, so the same line arriving twice (a tail
   * re-read) is one push and the next turn is another. Only subscribed
   * conversations are ever recorded, so it is bounded by the subscriptions.
   */
  private lastEnd = new Map<string, number>();

  constructor(
    private readonly deps: {
      sender: ExpoPushSender;
      repo: PushRepository;
      meta: (conversationId: string) => ConversationMeta | null;
      now?: () => number;
    },
  ) {}

  async onLines(conversationId: string, lines: string[]): Promise<void> {
    try {
      // Cheapest test first: almost no batch holds a turn end, and this runs for
      // every line every external session writes.
      if (!lines.some((l) => l.includes("turn_"))) return;
      if (!this.deps.repo.hasSubscribers(conversationId)) return;
      const meta = this.deps.meta(conversationId);
      if (!meta) return;

      const endAt = transcriptTurnEndAt(meta.provider, lines);
      const now = (this.deps.now ?? Date.now)();
      if (endAt === null || now - endAt > EXTERNAL_TURN_MAX_AGE_MS) return;
      // Recorded before the await so two batches racing on one line push once.
      if (endAt <= (this.lastEnd.get(conversationId) ?? 0)) return;
      this.lastEnd.set(conversationId, endAt);

      const only = this.deps.repo.subscribedTokens(conversationId);
      const outcome = await this.deps.sender.send(
        waitingInputMessage(
          {
            id: conversationId,
            projectName: meta.projectName ?? "Session",
            branch: meta.branch ?? "",
            provider: meta.provider,
          },
          "turn_done",
        ),
        { event: "waitingInput", only },
      );
      if (outcome.attempted > 0) this.deps.repo.touchSubscriptions(conversationId, now);
      if (outcome.attempted > 0 || outcome.suppressed > 0) {
        log.info("expo_push.external_turn", {
          event: "expo_push.external_turn",
          conversationId,
          provider: meta.provider,
          ...outcome,
        });
      }
    } catch (err) {
      log.error("expo_push.notify_failed", {
        event: "expo_push.notify_failed",
        conversationId,
        err: String(err),
      });
    }
  }
}
