import type { PushRepository, PushTokenRow } from "../../db/repositories/push.repository";
import { getLogger } from "../../logger";

/**
 * Ordinary push notifications, sent through Expo's relay.
 *
 * Deliberately not the APNs path. `ApnsClient` signs with a `.p8` for
 * `${bundleId}.push-type.liveactivity`, and Apple issues those keys per
 * developer team — a self-hosted streamer cannot sign for the published app's
 * bundle id, so anything built on it works only for the maintainer. Expo holds
 * the APNs and FCM credentials for the app, so any streamer can send with a
 * plain POST, no Apple credential and one code path for both platforms.
 *
 * Self-hosting is the primary deployment, which is what makes this the
 * transport for ordinary notifications.
 */

const log = getLogger("expo-push");

export const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** Expo accepts at most 100 messages per request. */
export const EXPO_PUSH_BATCH_SIZE = 100;

export interface ExpoPushMessage {
  title: string;
  body: string;
  /** Delivered to the app as `notification.request.content.data`. */
  data: Record<string, string>;
}

export interface ExpoPushOutcome {
  attempted: number;
  succeeded: number;
  /** Tokens Expo rejected as permanently dead, now revoked locally. */
  retired: number;
}

/** One entry of Expo's `data` array, positionally matched to the request. */
interface ExpoPushTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * The one ticket error that means "this token will never work again" — the app
 * was uninstalled, or the token rotated. Every other error (rate limit,
 * message too big, a relay hiccup) is transient and only counts toward the
 * repository's failure streak.
 */
const DEAD_TOKEN_ERROR = "DeviceNotRegistered";

export class ExpoPushSender {
  /**
   * @param accessToken Expo access token, when the project has enhanced
   * security enabled. Optional on purpose: a self-hoster does not own the Expo
   * project and cannot obtain one, so requiring it would break the deployment
   * this transport exists to serve.
   */
  constructor(
    private readonly repo: PushRepository,
    private readonly accessToken?: string,
  ) {}

  /**
   * Send one message to every deliverable Expo token.
   *
   * Sends are independent: Expo returns a ticket per token in one response, so
   * a dead device is recorded against its own row and never silences the other
   * devices in the batch.
   */
  async send(message: ExpoPushMessage, now: number = Date.now()): Promise<ExpoPushOutcome> {
    const rows = this.repo.listDeliverable();
    const outcome: ExpoPushOutcome = { attempted: rows.length, succeeded: 0, retired: 0 };
    if (rows.length === 0) return outcome;

    for (let i = 0; i < rows.length; i += EXPO_PUSH_BATCH_SIZE) {
      const chunk = rows.slice(i, i + EXPO_PUSH_BATCH_SIZE);
      await this.sendChunk(chunk, message, now, outcome);
    }
    return outcome;
  }

  private async sendChunk(
    rows: PushTokenRow[],
    message: ExpoPushMessage,
    now: number,
    outcome: ExpoPushOutcome,
  ): Promise<void> {
    let payload: unknown;
    try {
      const res = await fetch(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.accessToken && { authorization: `Bearer ${this.accessToken}` }),
        },
        body: JSON.stringify(rows.map((row) => ({ to: row.token, ...message }))),
      });
      if (!res.ok) {
        // A request-level rejection (bad access token, malformed batch) says
        // nothing about any individual device, so no token is retired here.
        const code = `HTTP_${res.status}`;
        for (const row of rows) this.repo.recordFailure(row.token, code, now);
        log.warn("expo_push.request_rejected", {
          event: "expo_push.request_rejected",
          status: res.status,
          tokens: rows.length,
        });
        return;
      }
      payload = await res.json();
    } catch (err) {
      // Never swallowed: without this the user simply stops being told their
      // turn is up, and there is nothing anywhere to explain why.
      for (const row of rows) this.repo.recordFailure(row.token, "SendError", now);
      log.error("expo_push.send_failed", {
        event: "expo_push.send_failed",
        tokens: rows.length,
        err: String(err),
      });
      return;
    }

    const tickets = (payload as { data?: ExpoPushTicket[] } | null)?.data;
    rows.forEach((row, index) => {
      const ticket = Array.isArray(tickets) ? tickets[index] : undefined;
      if (!ticket) {
        // Expo returns one ticket per message, positionally. A short array
        // means we cannot say this device was reached, so it is a failure.
        this.repo.recordFailure(row.token, "NoTicket", now);
        return;
      }
      if (ticket.status === "ok") {
        this.repo.recordSuccess(row.token, now);
        outcome.succeeded += 1;
        return;
      }

      const code = ticket.details?.error ?? "PushError";
      this.repo.recordFailure(row.token, code, now);
      if (code === DEAD_TOKEN_ERROR) {
        // Retire rather than retry, mirroring how LiveActivitySender expires a
        // dead APNs token: this one fails forever, and retrying it makes the
        // health report read "failing" when the device is simply gone.
        this.repo.revoke(row.token, now);
        outcome.retired += 1;
      }
      log.warn("expo_push.send_rejected", {
        event: "expo_push.send_rejected",
        code,
        message: ticket.message,
        retired: code === DEAD_TOKEN_ERROR,
      });
    });
  }
}
