import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { PushRepository, tokenState } from "../src/db/repositories/push.repository";
import { ExpoPushSender } from "../src/services/push/expoPushSender";
import {
  EXPO_RECEIPTS_ENDPOINT,
  ExpoReceiptPoller,
  RECEIPT_BATCH_SIZE,
  RECEIPT_DELAY_MS,
  RECEIPT_RETENTION_MS,
  RECEIPT_SWEEP_MS,
} from "../src/services/push/expoReceiptPoller";

/**
 * Receipt polling (#543). A ticket of `status: "ok"` only says Expo accepted the
 * message; the delivery outcome is behind getReceipts, a while later.
 *
 * Every token and ticket id below is a made-up fixture.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: Record<string, unknown> }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: Record<string, unknown>) =>
    h.calls.push({ level, msg, fields });
  const fake = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    log: () => {},
    pino: { isLevelEnabled: () => false },
  };
  return { getLogger: () => fake, logger: fake };
});

const T0 = 1_700_000_000_000;
const TOK_A = "ExponentPushToken[aaa]";
const TOK_B = "ExponentPushToken[bbb]";

let dir: string;
let cache: ConversationCache;
let repo: PushRepository;

beforeEach(() => {
  h.calls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "tb-receipts-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
  repo = new PushRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Reply = { ok?: boolean; status?: number; body?: unknown } | Error;

/** An injectable fetch answering with one reply per call, the last one repeating. */
function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; ids: string[]; headers: Record<string, string> }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      ids: JSON.parse(String(init.body)).ids,
      headers: init.headers as Record<string, string>,
    });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body ?? { data: {} } };
  });
  return { fn: fn as unknown as typeof fetch, calls, spy: fn };
}

function poller(fetchImpl: typeof fetch, accessToken?: string) {
  return new ExpoReceiptPoller(repo, { fetch: fetchImpl, accessToken });
}

function rowCount(): number {
  const row = cache.getDatabase().prepare("SELECT COUNT(*) AS n FROM push_receipts").get() as {
    n: number;
  };
  return row.n;
}

/** Send one push to `tokens` and get back ticket ids `t-<token index>`. */
async function sendWithTickets(tokens: string[], now = T0) {
  for (const t of tokens) repo.register({ token: t, platform: "ios", now });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: tokens.map((_, i) => ({ status: "ok", id: `t-${i}` })) }),
    })),
  );
  return new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} }, { now });
}

describe("send path stops claiming delivery", () => {
  it("saves the ticket and does not advance last_success_at on an accepted ticket", async () => {
    const outcome = await sendWithTickets([TOK_A]);

    // The wire response of the send is unchanged: accepted is still "succeeded".
    expect(outcome).toEqual({ attempted: 1, succeeded: 1, retired: 0, suppressed: 0 });
    expect(repo.get(TOK_A)?.last_success_at).toBeNull();
    expect(tokenState(repo.get(TOK_A) as never)).toBe("never-delivered");
    expect(rowCount()).toBe(1);
  });

  it("falls back to recording success when an ok ticket carries no id", async () => {
    repo.register({ token: TOK_A, platform: "ios" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ status: "ok" }] }),
      })),
    );
    await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} }, { now: T0 });

    expect(repo.get(TOK_A)?.last_success_at).toBe(T0);
    expect(rowCount()).toBe(0);
  });

  it("still records a ticket-level failure immediately", async () => {
    repo.register({ token: TOK_A, platform: "ios" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ status: "error", details: { error: "MessageRateExceeded" } }],
        }),
      })),
    );
    await new ExpoPushSender(repo).send({ title: "p", body: "b", data: {} }, { now: T0 });

    expect(repo.get(TOK_A)?.last_failure_code).toBe("MessageRateExceeded");
    expect(rowCount()).toBe(0);
  });
});

describe("ExpoReceiptPoller.tick", () => {
  it("asks for nothing before the delay has passed", async () => {
    await sendWithTickets([TOK_A]);
    const { fn, spy } = fakeFetch([{}]);

    await poller(fn).tick(T0 + RECEIPT_DELAY_MS - 1);

    expect(spy).not.toHaveBeenCalled();
    expect(rowCount()).toBe(1);
  });

  it("turns an ok receipt into recordSuccess at poll time and drops the row", async () => {
    await sendWithTickets([TOK_A]);
    repo.recordFailure(TOK_A, "PushError", T0); // a prior streak the delivery should clear
    const { fn, calls } = fakeFetch([{ body: { data: { "t-0": { status: "ok" } } } }]);
    const at = T0 + RECEIPT_DELAY_MS;

    await poller(fn, "secret-access-token").tick(at);

    expect(calls[0].url).toBe(EXPO_RECEIPTS_ENDPOINT);
    expect(calls[0].ids).toEqual(["t-0"]);
    expect(calls[0].headers.authorization).toBe("Bearer secret-access-token");
    const row = repo.get(TOK_A);
    expect(row?.last_success_at).toBe(at);
    expect(row?.failure_streak).toBe(0);
    expect(tokenState(row as never, at)).toBe("healthy");
    expect(rowCount()).toBe(0);
  });

  it("revokes the token on a DeviceNotRegistered receipt, like the send path", async () => {
    await sendWithTickets([TOK_A, TOK_B]);
    const { fn } = fakeFetch([
      {
        body: {
          data: {
            "t-0": { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
            "t-1": { status: "ok" },
          },
        },
      },
    ]);
    const at = T0 + RECEIPT_DELAY_MS;

    await poller(fn).tick(at);

    const dead = repo.get(TOK_A);
    expect(dead?.revoked_at).toBe(at);
    expect(dead?.last_failure_code).toBe("DeviceNotRegistered");
    expect(dead?.failure_streak).toBe(1);
    expect(repo.listDeliverable().map((r) => r.token)).toEqual([TOK_B]);
    expect(repo.get(TOK_B)?.last_success_at).toBe(at);
    expect(rowCount()).toBe(0);
  });

  it("counts any other receipt error as a failure without revoking", async () => {
    await sendWithTickets([TOK_A]);
    const { fn } = fakeFetch([
      { body: { data: { "t-0": { status: "error", details: { error: "MessageRateExceeded" } } } } },
    ]);

    await poller(fn).tick(T0 + RECEIPT_DELAY_MS);

    const row = repo.get(TOK_A);
    expect(row?.revoked_at).toBeNull();
    expect(row?.last_failure_code).toBe("MessageRateExceeded");
    expect(row?.failure_streak).toBe(1);
    expect(rowCount()).toBe(0);
  });

  it("records PushError for an error receipt with no code", async () => {
    await sendWithTickets([TOK_A]);
    const { fn } = fakeFetch([{ body: { data: { "t-0": { status: "error" } } } }]);

    await poller(fn).tick(T0 + RECEIPT_DELAY_MS);

    expect(repo.get(TOK_A)?.last_failure_code).toBe("PushError");
  });

  it("leaves an id Expo does not return, polls it later, and never counts it a failure", async () => {
    await sendWithTickets([TOK_A]);
    const { fn, spy } = fakeFetch([{ body: { data: {} } }]);
    const p = poller(fn);

    await p.tick(T0 + RECEIPT_DELAY_MS);
    expect(rowCount()).toBe(1);
    expect(repo.get(TOK_A)?.failure_streak).toBe(0);
    expect(repo.get(TOK_A)?.last_success_at).toBeNull();

    await p.tick(T0 + RECEIPT_DELAY_MS + RECEIPT_SWEEP_MS);
    expect(spy).toHaveBeenCalledTimes(2);

    // Past retention the row is dropped by the delete, still not as a failure.
    await p.tick(T0 + RECEIPT_RETENTION_MS + 1);
    expect(rowCount()).toBe(0);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(repo.get(TOK_A)?.failure_streak).toBe(0);
    expect(repo.get(TOK_A)?.last_failure_code).toBeNull();
  });

  it("keeps rows and changes nothing when the network fails or Expo rejects the request", async () => {
    await sendWithTickets([TOK_A]);
    const { fn } = fakeFetch([
      new Error("ECONNRESET"),
      { ok: false, status: 503, body: { data: { "t-0": { status: "ok" } } } },
    ]);
    const p = poller(fn);

    await expect(p.tick(T0 + RECEIPT_DELAY_MS)).resolves.toBeUndefined();
    await expect(p.tick(T0 + RECEIPT_DELAY_MS + 1)).resolves.toBeUndefined();

    expect(rowCount()).toBe(1);
    const row = repo.get(TOK_A);
    expect(row?.failure_streak).toBe(0);
    expect(row?.last_success_at).toBeNull();
  });

  it("never throws when the body is not JSON", async () => {
    await sendWithTickets([TOK_A]);
    const fn = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    })) as unknown as typeof fetch;

    await expect(poller(fn).tick(T0 + RECEIPT_DELAY_MS)).resolves.toBeUndefined();
    expect(rowCount()).toBe(1);
  });

  it("ignores a receipt of unknown status and keeps the row", async () => {
    await sendWithTickets([TOK_A]);
    const { fn } = fakeFetch([{ body: { data: { "t-0": { status: "weird" } } } }]);

    await poller(fn).tick(T0 + RECEIPT_DELAY_MS);

    expect(rowCount()).toBe(1);
    expect(repo.get(TOK_A)?.last_success_at).toBeNull();
  });

  it("sends at most RECEIPT_BATCH_SIZE ids per tick and rotates through the rest", async () => {
    const n = RECEIPT_BATCH_SIZE + 5;
    repo.register({ token: TOK_A, platform: "ios", now: T0 });
    for (let i = 0; i < n; i++) repo.saveTicket(`id-${i}`, TOK_A, T0 + i);
    const { fn, calls } = fakeFetch([{ body: { data: {} } }]);
    const p = poller(fn);
    const at = T0 + RECEIPT_DELAY_MS + n;

    await p.tick(at);
    expect(calls[0].ids).toHaveLength(RECEIPT_BATCH_SIZE);

    // The unanswered ones went to the back, so the next tick reaches the unpolled five.
    await p.tick(at + RECEIPT_SWEEP_MS);
    expect(calls[1].ids).toHaveLength(RECEIPT_BATCH_SIZE);
    const unpolled = Array.from({ length: 5 }, (_, i) => `id-${RECEIPT_BATCH_SIZE + i}`);
    expect(calls[1].ids).toEqual(expect.arrayContaining(unpolled));
    expect(calls[0].ids).not.toEqual(expect.arrayContaining(unpolled));
  });

  it("does not run two polls at once", async () => {
    await sendWithTickets([TOK_A]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spy = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ data: { "t-0": { status: "ok" } } }) };
    });
    const p = poller(spy as unknown as typeof fetch);
    const at = T0 + RECEIPT_DELAY_MS;

    const first = p.tick(at);
    await p.tick(at);
    release();
    await first;

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("logs push.receipts_polled with counts only", async () => {
    await sendWithTickets([TOK_A, TOK_B]);
    const { fn } = fakeFetch([
      {
        body: {
          data: {
            "t-0": { status: "error", details: { error: "DeviceNotRegistered" } },
            "t-1": { status: "ok" },
          },
        },
      },
    ]);

    await poller(fn).tick(T0 + RECEIPT_DELAY_MS);

    const line = h.calls.find((c) => c.fields?.event === "push.receipts_polled");
    expect(line?.fields).toMatchObject({
      polled: 2,
      delivered: 1,
      failed: 1,
      retired: 1,
      pending: 0,
      purged: 0,
    });
    const dump = JSON.stringify(h.calls);
    expect(dump).not.toContain("ExponentPushToken");
    expect(dump).not.toContain("t-0");
    expect(dump).not.toContain("t-1");
  });

  it("is silent when there is nothing to poll or purge", async () => {
    const { fn } = fakeFetch([{}]);
    await poller(fn).tick(T0);
    expect(h.calls).toEqual([]);
  });
});

describe("receipt rows and the token store", () => {
  it("are erased with the token, so unregistering leaves no ticket behind", async () => {
    await sendWithTickets([TOK_A]);
    expect(rowCount()).toBe(1);

    repo.deleteToken(TOK_A);

    expect(rowCount()).toBe(0);
  });

  it("saveTicket is idempotent for one ticket id", () => {
    repo.register({ token: TOK_A, platform: "ios" });
    repo.saveTicket("dup", TOK_A, T0);
    repo.saveTicket("dup", TOK_A, T0 + 1);
    expect(rowCount()).toBe(1);
  });
});

describe("ExpoReceiptPoller timer", () => {
  it("sweeps on one unref'd interval and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    await sendWithTickets([TOK_A]);
    const { fn, spy } = fakeFetch([{ body: { data: { "t-0": { status: "ok" } } } }]);
    const p = poller(fn);
    const unref = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const t = realSetInterval(...args);
      const origUnref = t.unref.bind(t);
      t.unref = () => {
        unref();
        return origUnref();
      };
      return t;
    }) as typeof setInterval);

    p.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(RECEIPT_SWEEP_MS);
    expect(unref).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MS + RECEIPT_SWEEP_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(repo.get(TOK_A)?.last_success_at).not.toBeNull();

    p.stop();
    await sendWithTickets([TOK_B], Date.now());
    await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MS + 2 * RECEIPT_SWEEP_MS);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
