/**
 * A sliding-window rate limiter for a public endpoint.
 *
 * **The POLICY is shared through this module; the arithmetic deliberately is
 * not** (NONCE-DESIGN §8). `/open` enforces the same 5 attempts per minute that
 * `/api/pair/exchange` enforces, and takes those numbers from the constants
 * below so the two cannot drift.
 *
 * The bucket arithmetic is a second implementation on purpose:
 * `StreamerServer.checkExchangeRateLimit` is a private method over private
 * per-map state on a class in `src/server.ts`, so sharing the code — rather
 * than the policy — would mean deleting that method and rewiring its three call
 * sites in a file another track owns. Consolidating the two is a named
 * follow-up, and it belongs to whoever next touches `server.ts`. Reaching into
 * that file to "fix" this module is the wrong direction.
 *
 * The KEY is the caller's choice and `/open` does not use the IP: NONCE-DESIGN
 * §8 records that behind a Cloudflare tunnel every request arrives from
 * 127.0.0.1, so an IP-keyed bucket is one bucket for the whole fleet. `/open`
 * keys on the authenticated static key instead, and charges the IP only for a
 * handshake that failed and therefore named nobody.
 */
/** True when the caller may proceed; false when it has spent its budget. */
export type RateLimiter = (key: string) => boolean;

/**
 * Same numbers `/api/pair/exchange` enforces today.
 *
 * **A tunable, and named as one.** Five `/open` per minute per device is tight
 * on a flaky network: a foreground, a silence-timer reconnect and a lazy REST
 * open can legitimately arrive as three in one burst, and the client's
 * single-flight (§8) is what keeps that from becoming six. If field data shows
 * legitimate devices hitting the ceiling, this is the number to raise — the
 * per-device context cap, not this, is the bound that actually stops a
 * replayer.
 */
export const PAIR_EXCHANGE_LIMIT = 5;
export const PAIR_EXCHANGE_WINDOW_MS = 60_000;

/**
 * Failed `/api/e2ee/open` handshakes tolerated per source address per minute.
 *
 * **Deliberately far above the per-device limit, because it bounds a different
 * thing.** The per-device number bounds ALLOCATION and can be tight; this one
 * bounds CPU on a key nobody has authenticated, and behind a Cloudflare tunnel
 * every request arrives from `127.0.0.1` — so a tight number here is a denial
 * of service against the whole fleet rather than against an attacker. At five,
 * an adversary showed that five malformed messages locked out every paired
 * device on that address, including one mid-recovery.
 *
 * Thirty is above anything a real device does — a device's own recovery is two
 * or three handshakes, and they succeed, which costs this budget nothing — and
 * far below what a flood needs to be interesting.
 *
 * A tunable. If field evidence shows legitimate traffic reaching it, raise it;
 * the per-device cap on contexts, not this, is the bound that stops a replayer.
 */
export const OPEN_SOURCE_FAILURE_LIMIT = 30;

/** Keys tracked before a full sweep runs. Bounds the map on a spray of IPs. */
const SWEEP_AFTER_KEYS = 1024;

/**
 * A budget whose check and charge are SEPARATE.
 *
 * `createRateLimiter` charges every call, which is right when every call is
 * the thing being limited. It is wrong for a failure budget: there, a caller
 * must be able to ask "does this source still have room?" before doing the
 * expensive work, and spend from the budget only when that work turned out to
 * be wasted. Fusing the two would charge a legitimate caller for succeeding.
 */
export interface RateBudget {
  /** True when `key` still has room. Charges nothing. */
  check(key: string): boolean;
  /** Spend one unit against `key`. */
  charge(key: string): void;
}

export function createRateBudget(options: { limit: number; windowMs: number }): RateBudget {
  const hits = new Map<string, number[]>();

  const recentFor = (key: string, now: number): number[] => {
    if (hits.size > SWEEP_AFTER_KEYS) {
      for (const [k, times] of hits) {
        if (times.every((t) => now - t >= options.windowMs)) hits.delete(k);
      }
    }
    const recent = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs);
    hits.set(key, recent);
    return recent;
  };

  return {
    check(key: string): boolean {
      return recentFor(key, Date.now()).length < options.limit;
    },
    charge(key: string): void {
      const now = Date.now();
      recentFor(key, now).push(now);
    },
  };
}

export function createRateLimiter(options: { limit: number; windowMs: number }): RateLimiter {
  const budget = createRateBudget(options);
  return (key: string): boolean => {
    if (!budget.check(key)) return false;
    budget.charge(key);
    return true;
  };
}
