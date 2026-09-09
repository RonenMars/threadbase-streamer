import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { type ConversationMessage, parseCodexJsonlLine } from "@threadbase-sh/scanner";

/**
 * A conversation whose history begins in ANOTHER file.
 *
 * `codex fork` does not copy the source transcript. It writes a rollout holding
 * only `session_meta`, pointing back at the parent with `forked_from_id` and
 * `forked_from_ordinal_exclusive` — Codex reads the parent up to the cut and
 * carries on. So the agent has the full context while the transcript we serve
 * has none: the fork is not empty, it is elsewhere.
 *
 * Nothing here is Codex-specific by contract. The link is "this conversation
 * inherits a prefix of that one", and a second producer would only need its own
 * `readForkLinkFromLine`.
 */

/** Deepest chain (fork of a fork of a …) we will resolve. */
const MAX_CHAIN_DEPTH = 8;

/**
 * Resolved prefixes held in memory. Each entry pins a message array, so this is
 * a memory/parse trade: past the cap, every eviction costs a full re-parse of a
 * parent prefix. 8 was low enough that someone with a handful of forks open
 * thrashed it. Raised rather than replaced with a windowed read — see
 * "Why the split-window read was dropped" in
 * docs/plans/2026-09-07-inherited-conversation-history.md.
 */
const PREFIX_CACHE_MAX = 32;

export interface InheritedLink {
  /** Provider-side id of the conversation this one continues. */
  sourceId: string;
  /**
   * The cut, as the provider writes it: a LINE ordinal, exclusive.
   *
   * Not a message index. In a real rollout, ordinals count every envelope line
   * — token counts, task events, turn context — while only a fraction render as
   * messages. Translating one to the other is `countMessagesBeforeOrdinal`, and
   * skipping that translation is the silent failure this module exists to
   * prevent.
   */
  ordinalExclusive: number;
  forkedAt: string | null;
}

export interface InheritedHistory extends InheritedLink {
  sourceFilePath: string | null;
  /** The inherited messages, oldest first. Empty when the source is unreadable. */
  messages: ConversationMessage[];
  /** Set when the source could not be read; `messages` is then empty. */
  unavailableReason: "source_missing" | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Read a fork link out of one JSONL line, or null if it carries none.
 *
 * Tolerant by construction, like every provider parser here: malformed JSON, a
 * missing payload, or a partial link (an id with no ordinal) all mean "no
 * link", never a throw. A conversation that is not a fork is the overwhelmingly
 * common case and must cost nothing.
 */
export function readForkLinkFromLine(line: string): InheritedLink | null {
  let entry: Record<string, unknown> | null;
  try {
    entry = asRecord(JSON.parse(line));
  } catch {
    return null;
  }
  if (entry?.type !== "session_meta") return null;

  const payload = asRecord(entry.payload);
  if (!payload) return null;

  const sourceId = payload.forked_from_id;
  const ordinal = payload.forked_from_ordinal_exclusive;
  if (typeof sourceId !== "string" || sourceId.length === 0) return null;
  if (typeof ordinal !== "number" || !Number.isFinite(ordinal) || ordinal < 0) return null;

  const forkedAt = typeof payload.timestamp === "string" ? payload.timestamp : null;
  return { sourceId, ordinalExclusive: ordinal, forkedAt };
}

/**
 * Whether a file is a fork, and of what, keyed by path.
 *
 * A rollout's first line is written once, at creation, and never rewritten — and
 * the path carries the session uuid, so a path cannot come to mean a different
 * conversation. The answer is therefore permanent, including the "not a fork"
 * answer, which is the one nearly every lookup gets.
 *
 * This is what keeps the feature off the hot path: without it every Codex
 * conversation request re-opens the file to re-learn something that cannot have
 * changed, and that latency is not free — it was enough to shift a pre-existing
 * refresh-throttle race in the scanner manager from rare to routine.
 */
const linkCache = new Map<string, InheritedLink | null>();
const LINK_CACHE_MAX = 512;

/** Test seam: the caches are process-global and would otherwise leak across tests. */
export function clearInheritedLinkCache(): void {
  linkCache.clear();
}

/**
 * A fork declares itself on its FIRST line, so this reads one line and stops.
 * Returns null for a file that isn't there — an absent file is not a fork.
 */
export async function readForkLink(filePath: string): Promise<InheritedLink | null> {
  const cached = linkCache.get(filePath);
  if (cached !== undefined) return cached;
  const link = await readForkLinkUncached(filePath);
  if (linkCache.size >= LINK_CACHE_MAX) {
    const oldest = linkCache.keys().next().value;
    if (oldest !== undefined) linkCache.delete(oldest);
  }
  linkCache.set(filePath, link);
  return link;
}

async function readForkLinkUncached(filePath: string): Promise<InheritedLink | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: InheritedLink | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(filePath);
    } catch {
      done(null);
      return;
    }
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    // Closing the readline interface does NOT close the file it reads from, and
    // this runs on every Codex conversation request — so the stream is destroyed
    // explicitly. Without it each request leaks a descriptor until GC.
    const finish = (value: InheritedLink | null) => {
      // Settle BEFORE closing: rl.close() emits 'close' synchronously, and that
      // handler resolves with null — so cleaning up first throws the answer away.
      done(value);
      rl.close();
      stream.destroy();
    };
    rl.on("line", (line) => {
      if (line.trim()) finish(readForkLinkFromLine(line));
    });
    rl.on("close", () => done(null));
    rl.on("error", () => finish(null));
    stream.on("error", () => finish(null));
  });
}

/**
 * The messages of `filePath` that precede line ordinal `ordinalExclusive`.
 *
 * The message decision is `parseCodexJsonlLine`, imported rather than
 * reimplemented: it is the same rule the scanner renders with, so the count
 * here cannot drift from what the conversation actually shows. Re-deriving it
 * locally is how a fork ends up displaying turns it never inherited.
 *
 * `ordinal` is read off each line, with the line counter as the fallback for a
 * writer that omits it — in observed rollouts the two are identical (a 331-line
 * file carries ordinals 0–330), so the fallback is a degrade path, not a guess.
 */
export async function readMessagesBeforeOrdinal(
  filePath: string,
  ordinalExclusive: number,
): Promise<ConversationMessage[] | null> {
  const messages: ConversationMessage[] = [];
  let lineNumber = -1;
  const stream = createReadStream(filePath);
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineNumber++;
      let ordinal = lineNumber;
      try {
        const entry = asRecord(JSON.parse(line));
        if (entry && typeof entry.ordinal === "number") ordinal = entry.ordinal;
      } catch {
        // Unparseable line: it renders as nothing either way, and the line
        // counter still advances, so the cut stays in the right place.
      }
      if (ordinal >= ordinalExclusive) {
        rl.close();
        break;
      }
      const message = parseCodexJsonlLine(line);
      if (message) messages.push(message);
    }
  } catch {
    return null;
  } finally {
    // Same reason as readForkLink: breaking out of the loop leaves the file
    // open, and this one stops early by design.
    stream.destroy();
  }
  return messages;
}

/**
 * Prefixes are immutable — everything before the cut is frozen even while the
 * source file keeps growing — so the key needs no mtime and a hit stays valid
 * for the life of the process. Bounded because each entry pins its messages.
 */
const prefixCache = new Map<string, ConversationMessage[]>();

function cachePrefix(key: string, messages: ConversationMessage[]): void {
  if (prefixCache.size >= PREFIX_CACHE_MAX) {
    const oldest = prefixCache.keys().next().value;
    if (oldest !== undefined) prefixCache.delete(oldest);
  }
  prefixCache.set(key, messages);
}

/** Test seam: the cache is process-global and would otherwise leak across tests. */
export function clearInheritedPrefixCache(): void {
  prefixCache.clear();
  linkCache.clear();
}

export interface ResolveInheritedOptions {
  /** The conversation being served — the fork, not the source. */
  filePath: string;
  /** Resolve a conversation id to its file, or null when it can't be found. */
  locateSource: (conversationId: string) => Promise<string | null>;
}

/**
 * Resolve the full inherited prefix for a conversation, following a chain of
 * forks oldest-first.
 *
 * Returns null when the conversation inherits nothing, which is the normal
 * case and costs one line read.
 *
 * A source that cannot be found does NOT fail the request: the fork's own
 * messages are still served, with `unavailableReason` set so the client can say
 * the earlier history is unavailable instead of silently showing a truncated
 * conversation. That degrade is what makes it safe to keep pointing at the
 * source file rather than copying it.
 */
export async function resolveInheritedHistory(
  opts: ResolveInheritedOptions,
): Promise<InheritedHistory | null> {
  const link = await readForkLink(opts.filePath);
  if (!link) return null;

  const messages: ConversationMessage[] = [];
  const seen = new Set<string>();
  let current: InheritedLink | null = link;
  let sourceFilePath: string | null = null;
  let unavailableReason: "source_missing" | null = null;
  // Each hop's prefix is older than the last, so they are collected newest-first
  // and reversed once at the end.
  const segments: ConversationMessage[][] = [];

  for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth++) {
    // A cycle is impossible in a well-formed chain and unbounded work if it
    // happens anyway. Refuse rather than recurse.
    if (seen.has(current.sourceId)) {
      unavailableReason = "source_missing";
      break;
    }
    seen.add(current.sourceId);

    const path = await opts.locateSource(current.sourceId);
    if (depth === 0) sourceFilePath = path;
    if (!path) {
      unavailableReason = "source_missing";
      break;
    }

    const key = `${path}::${current.ordinalExclusive}`;
    let segment = prefixCache.get(key);
    if (!segment) {
      const read = await readMessagesBeforeOrdinal(path, current.ordinalExclusive);
      if (!read) {
        unavailableReason = "source_missing";
        break;
      }
      segment = read;
      cachePrefix(key, segment);
    }
    segments.push(segment);

    const next: InheritedLink | null = await readForkLink(path);
    // A source that is itself a fork contributes only the part of ITS history
    // that precedes this cut — never more than the hop below already took.
    current = next
      ? { ...next, ordinalExclusive: Math.min(next.ordinalExclusive, current.ordinalExclusive) }
      : null;
  }

  for (let i = segments.length - 1; i >= 0; i--) messages.push(...segments[i]);

  return {
    ...link,
    sourceFilePath,
    messages: unavailableReason ? [] : messages,
    unavailableReason,
  };
}
