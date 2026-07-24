/**
 * Idempotency for session input (C4).
 *
 * `POST /api/sessions/:id/input` had no duplicate protection. A retry — a flaky
 * network, a user double-tap, a client that resends on timeout — submitted the
 * same prompt to the agent twice, and nothing downstream could tell the second
 * submission from a deliberate repeat of the same words.
 *
 * The rate limiter does not help: 500 requests/minute is aimed at floods, and a
 * genuine retry is well inside it.
 *
 * Clients send `idempotencyKey` with a write. A repeat of a key we have already
 * accepted replays the original outcome instead of re-submitting.
 *
 * Scoped per session, because a key is only meaningful against the conversation
 * it was minted for — the same key against a different session is a different
 * write, and treating it as a duplicate would silently drop a real prompt.
 */

/** How long a key is remembered. Long enough to cover a retry, not a session. */
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/**
 * Cap on remembered keys per session. Bounds memory on a long conversation; the
 * oldest entries are evicted first, so a key older than the cap behaves as if it
 * had expired — the request is treated as new.
 */
export const IDEMPOTENCY_MAX_KEYS = 200;

export interface IdempotentResult {
  status: number;
  body: unknown;
}

interface Entry {
  key: string;
  at: number;
  result: IdempotentResult;
}

/**
 * Per-session record of recently accepted idempotency keys.
 *
 * Deliberately in-memory: this guards against retries seconds apart, and a
 * streamer restart already ends the PTY those retries would target (see the
 * durable-session-runtime ADR). Persisting it would imply a durability the
 * surrounding runtime does not have.
 */
export class IdempotencyStore {
  private bySession = new Map<string, Entry[]>();

  constructor(
    private ttlMs: number = IDEMPOTENCY_TTL_MS,
    private maxKeys: number = IDEMPOTENCY_MAX_KEYS,
  ) {}

  /**
   * Previously recorded result for this key, or null if the key is new,
   * expired, or evicted. A miss always means "treat as a fresh request" —
   * failing open, because dropping a real prompt is far worse than allowing a
   * rare duplicate.
   */
  get(sessionId: string, key: string, now: number = Date.now()): IdempotentResult | null {
    const entries = this.bySession.get(sessionId);
    if (!entries) return null;

    const hit = entries.find((e) => e.key === key);
    if (!hit) return null;
    if (now - hit.at > this.ttlMs) {
      this.bySession.set(
        sessionId,
        entries.filter((e) => e !== hit),
      );
      return null;
    }
    return hit.result;
  }

  /** Record the outcome of an accepted write so a retry can replay it. */
  set(sessionId: string, key: string, result: IdempotentResult, now: number = Date.now()): void {
    const entries = this.bySession.get(sessionId) ?? [];
    const pruned = entries.filter((e) => e.key !== key && now - e.at <= this.ttlMs);
    pruned.push({ key, at: now, result });
    // Oldest-first eviction; entries are appended in arrival order.
    this.bySession.set(sessionId, pruned.slice(-this.maxKeys));
  }

  /** Drop everything for a session whose PTY is gone. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Test/diagnostic helper: how many keys are currently held for a session. */
  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }
}

/**
 * Extract and validate an idempotency key from a request body.
 *
 * Returns `undefined` when absent (the field is optional, so existing clients
 * keep working) and throws on a present-but-invalid value rather than ignoring
 * it — a client that sends a malformed key believes it has retry protection,
 * and silently proceeding without it would be worse than a clear rejection.
 */
export function readIdempotencyKey(body: Record<string, unknown>): string | undefined {
  const raw = body.idempotencyKey;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    throw new Error("idempotencyKey must be a non-empty string of at most 200 characters");
  }
  return raw;
}
