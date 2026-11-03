import type { PushRepository } from "../../db/repositories/push.repository";
import { getLogger } from "../../logger";
import { DEAD_TOKEN_REASONS } from "./apnsClient";

/**
 * Retention for `push_tokens` (#509), and only for that table.
 *
 * Device rows (`devices`, runtime.db) are never touched: a standing rule says
 * nothing deletes or revokes a device automatically.
 *
 * - **Dead**: a token Expo (`DeviceNotRegistered`, row revoked) or APNs (a
 *   dead-token reason, row expired) reported permanently invalid. Kept for
 *   `DEAD_TOKEN_GRACE_MS` so `/api/push/health` can still say why delivery
 *   stopped, then deleted.
 * - **Unused**: no registration and no successful send for `UNUSED_TOKEN_MS`.
 *   The app registers on launch, so a token that stays silent this long
 *   belongs to a phone that is not coming back.
 */

const log = getLogger("push-retention");

const DAY_MS = 24 * 60 * 60 * 1000;
export const UNUSED_TOKEN_MS = 90 * DAY_MS;
export const DEAD_TOKEN_GRACE_MS = 7 * DAY_MS;
export const PUSH_RETENTION_SWEEP_MS = DAY_MS;

export function sweepPushTokens(
  repo: PushRepository,
  now: number = Date.now(),
): { dead: number; unused: number } {
  const result = repo.pruneTokens({
    deadBefore: now - DEAD_TOKEN_GRACE_MS,
    unusedBefore: now - UNUSED_TOKEN_MS,
    apnsDeadReasons: [...DEAD_TOKEN_REASONS],
  });
  if (result.dead > 0 || result.unused > 0) {
    log.info("push.tokens_pruned", { event: "push.tokens_pruned", ...result });
  }
  return result;
}

/** Sweep now, then daily. Returns the function that stops it. */
export function startPushTokenRetention(repo: PushRepository): () => void {
  const run = () => {
    try {
      sweepPushTokens(repo);
    } catch (err) {
      // A failed sweep must not take the server down; the next one retries.
      log.error("push.tokens_prune_failed", {
        event: "push.tokens_prune_failed",
        err: String(err),
      });
    }
  };
  run();
  const timer = setInterval(run, PUSH_RETENTION_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
