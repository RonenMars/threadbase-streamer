/**
 * The Live Activity content-state contract, shared with tb-mobile.
 *
 * tb-mobile defines the mirror of this shape in `types/live-activity.ts` and
 * decodes it with a Swift `Codable` ActivityAttributes struct. A decode failure
 * in ActivityKit is silent — the Lock Screen surface simply stops updating,
 * with no error anywhere on the server — so a field name or type drifting apart
 * from mobile's struct breaks the feature invisibly. Treat this file as a
 * contract, not an internal type: changing it requires a coordinated tb-mobile
 * change.
 */

/**
 * Statuses the surface renders. Deliberately narrower than the server's
 * `SessionStatus`: `idle` has no Live Activity representation, because a session
 * that is no longer live gets an `end` event rather than an update carrying a
 * third status mobile has no case for.
 */
export type LiveActivityStatus = "running" | "waiting_input";

/** Longest `lastOutput` sent. Mobile truncates to the same bound. */
export const LAST_OUTPUT_MAX_LENGTH = 90;

export interface LiveActivityContentState {
  sessionId: string;
  serverId: string;
  projectName: string;
  status: LiveActivityStatus;
  /**
   * Epoch **milliseconds** of the session's start.
   *
   * iOS renders its own ticking elapsed timer from this, so the server must
   * never send a precomputed elapsed value and never push per-second updates.
   * Carried unchanged across a renewal — a fresh value makes the user's visible
   * timer reset to zero.
   */
  startedAt: number;
  lastOutput: string;
  serverLabel?: string;
  /**
   * User-visible session title, derived from the first user message.
   *
   * Absent until the first message is submitted (a session between spawn and
   * that point has no title yet); mobile falls back to `projectName` when unset.
   */
  sessionName?: string;
}

/**
 * Collapse a server session status onto the two the surface renders.
 *
 * Returns null for a status with no representation, which is the signal to send
 * an `end` rather than an update.
 */
export function toLiveActivityStatus(status: string): LiveActivityStatus | null {
  return status === "running" || status === "waiting_input" ? status : null;
}

/**
 * Trim terminal output to the field's bound.
 *
 * Terminal output is unbounded and the whole APNs payload must stay under 4 KB,
 * so this is what keeps a chatty session from producing a rejected push.
 * Newlines collapse to spaces because the surface renders a single line.
 */
export function truncateLastOutput(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length <= LAST_OUTPUT_MAX_LENGTH
    ? oneLine
    : oneLine.slice(0, LAST_OUTPUT_MAX_LENGTH);
}
