import type { PushRepository } from "../../db/repositories/push.repository";
import { getLogger } from "../../logger";
import { DEAD_TOKEN_ERROR } from "./expoPushSender";

/**
 * Delivery receipts for Expo push tickets (#543).
 *
 * `ExpoPushSender` keeps the id of every accepted ticket. About 15 minutes
 * later Expo can say what APNs/FCM did with it, and this turns that answer into
 * the same `recordSuccess` / `recordFailure` / `revoke` calls the send path
 * makes, so `last_success_at` advances only for a push that was delivered and a
 * token that died after acceptance is evicted the same way.
 */

const log = getLogger("expo-push");

export const EXPO_RECEIPTS_ENDPOINT = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo suggests waiting about 15 minutes before asking. */
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/** Expo keeps receipts about 24 hours; an id older than that is dropped, not failed. */
export const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Expo accepts at most 1000 ids per getReceipts request. */
export const RECEIPT_BATCH_SIZE = 1000;

export const RECEIPT_SWEEP_MS = 60 * 1000;

/** A hung request must not wedge the poller: the overlap guard would never release. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

interface ExpoReceipt {
  status?: string;
  message?: string;
  details?: { error?: string };
}

export class ExpoReceiptPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly repo: PushRepository,
    private readonly opts: { accessToken?: string; fetch?: typeof fetch } = {},
  ) {}

  /** Poll once a sweep interval. unref'd: this must never keep the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), RECEIPT_SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sweep: drop expired ids, ask Expo about up to one batch of due ones,
   * apply the answers. Never throws; a failed request leaves every row for the
   * next sweep.
   */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const purged = this.repo.purgeReceipts(now - RECEIPT_RETENTION_MS);
      const due = this.repo.listDueReceipts(now - RECEIPT_DELAY_MS, RECEIPT_BATCH_SIZE);
      const counts = { polled: 0, delivered: 0, failed: 0, retired: 0, pending: 0, purged };
      if (due.length > 0) {
        const receipts = await this.fetchReceipts(due.map((r) => r.ticket_id));
        if (receipts) {
          counts.polled = due.length;
          const unanswered: string[] = [];
          for (const { ticket_id, token } of due) {
            const receipt = receipts[ticket_id];
            if (receipt?.status === "ok") {
              this.repo.recordSuccess(token, now);
              counts.delivered += 1;
            } else if (receipt?.status === "error") {
              const code = receipt.details?.error ?? "PushError";
              this.repo.recordFailure(token, code, now);
              counts.failed += 1;
              if (code === DEAD_TOKEN_ERROR) {
                this.repo.revoke(token, now);
                counts.retired += 1;
              }
            } else {
              unanswered.push(ticket_id);
              continue;
            }
            this.repo.resolveReceipt(ticket_id);
          }
          this.repo.markReceiptsPolled(unanswered, now);
          counts.pending = unanswered.length;
        }
      }
      if (counts.polled > 0 || purged > 0) {
        log.info("push.receipts_polled", { event: "push.receipts_polled", ...counts });
      }
    } catch (err) {
      log.warn("push.receipts_poll_failed", {
        event: "push.receipts_poll_failed",
        err: String(err),
      });
    } finally {
      this.running = false;
    }
  }

  /** Expo's receipts keyed by ticket id, or null when the request did not succeed. */
  private async fetchReceipts(
    ids: string[],
  ): Promise<Record<string, ExpoReceipt | undefined> | null> {
    const res = await (this.opts.fetch ?? fetch)(EXPO_RECEIPTS_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(this.opts.accessToken && { authorization: `Bearer ${this.opts.accessToken}` }),
      },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("push.receipts_poll_failed", {
        event: "push.receipts_poll_failed",
        status: res.status,
      });
      return null;
    }
    const payload = (await res.json()) as { data?: Record<string, ExpoReceipt | undefined> } | null;
    return payload?.data ?? {};
  }
}
