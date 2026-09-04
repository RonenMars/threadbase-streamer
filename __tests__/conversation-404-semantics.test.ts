/**
 * What `GET /api/conversations/:id` is allowed to say when it finds nothing.
 *
 * Two bugs met here, and between them they produced 142 conversation 404s in a
 * three-week production log (2026-08-15 → 2026-09-04):
 *
 *  - 62% were a session that simply had not written a transcript yet. Claude
 *    creates `<sessionId>.jsonl` only on the first user turn — measured 0.0s to
 *    86.9s after `pty.ready`, and never at all when the user opens a session and
 *    walks away. A 404 there says "this does not exist" about a session the
 *    sessions endpoint is happily returning 200 for.
 *
 *  - The rest were made permanent by the 404 handler itself, which called
 *    `cache.invalidate(id)` on every miss. For a Codex rollout the cache row is
 *    the only rung of `locateJsonlPath` that can name the file, so one transient
 *    miss deleted the row and every later request 404'd on a conversation still
 *    sitting on disk — taking `/api/sessions/:id`, whose only fallback is that
 *    same row, down with it.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";
import type { ManagedSession } from "../src/types";

function makeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  return {
    writeHead: vi.fn((code: number) => {
      statusCode = code;
    }),
    end: vi.fn((body?: string) => {
      if (body) chunks.push(body);
    }),
    get statusCode() {
      return statusCode;
    },
    get body() {
      return chunks.join("");
    },
  } as unknown as ServerResponse & { body: string; statusCode: number };
}

function managedSession(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    projectPath: "/tmp",
    projectName: "tmp",
    branch: "main",
    status: "waiting_input",
    startedAt: new Date("2026-09-04T16:54:58.000Z"),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    ...over,
  } as ManagedSession;
}

type Opts = {
  session?: ManagedSession | null;
  metaFilePath?: string;
  lookupId?: string;
};

function makeHandlers(opts: Opts) {
  const invalidate = vi.fn();
  const handlers = new ConversationHandlers({
    // ready:null + no scan profiles = the cold-start path, which resolves via
    // locateJsonlPath alone. No projects dir and no cached path means it finds
    // nothing, which is exactly the state under test.
    scannerManager: { ready: null, current: undefined, projectsDirs: () => [] },
    scanProfiles: undefined,
    sessionStore: { getManaged: () => opts.session ?? null },
    ptyManager: { hasSession: () => false },
    cache: () => ({
      getMetaById: () => (opts.metaFilePath ? { filePath: opts.metaFilePath } : null),
      getConversationTail: () => null,
      invalidate,
    }),
    log: () => ({ warn: vi.fn(), info: vi.fn() }),
    rejectIfWarmingUp: () => false,
    resolveConversationLookupId: (id: string) => opts.lookupId ?? id,
    findLiveSessionFilePath: () => null,
    isBoundConversationLive: () => false,
  } as unknown as ConstructorParameters<typeof ConversationHandlers>[0]);
  return { handlers, invalidate };
}

const url = new URL("http://localhost/api/conversations/sess-1?msg_limit=80");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-conv404-"));
});

describe("a session with no transcript yet", () => {
  it("answers 200 with zero messages, not 404", async () => {
    const { handlers, invalidate } = makeHandlers({ session: managedSession() });
    const res = makeRes();

    await handlers.handleGetConversation("sess-1", url, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toEqual([]);
    expect(body.meta.id).toBe("sess-1");
    expect(body.meta.message_count).toBe(0);
    expect(body.message_pagination.total).toBe(0);
    // Nothing to self-heal: there is no ghost row, only a session yet to speak.
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("still 404s once the session HAS been prompted", async () => {
    // The guard has to stay narrow. A session with turns behind it and no
    // transcript on disk is real data loss, and must not be dressed up as empty.
    const { handlers } = makeHandlers({ session: managedSession({ promptCount: 3 }) });
    const res = makeRes();

    await handlers.handleGetConversation("sess-1", url, res);

    expect(res.statusCode).toBe(404);
  });
});

describe("the 404 self-heal", () => {
  it("does not delete the cache row on an unexplained miss", async () => {
    // The row names a file that is still there — we simply failed to resolve the
    // conversation this time. Deleting the row here is what turned a transient
    // miss into a permanent double-404.
    const present = join(dir, "still-here.jsonl");
    writeFileSync(present, "{}\n");

    const { handlers, invalidate } = makeHandlers({ session: null, metaFilePath: present });
    const res = makeRes();

    await handlers.handleGetConversation("sess-1", url, res);

    expect(res.statusCode).toBe(404);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does delete it when the file is proven gone — the positive control", async () => {
    const { handlers, invalidate } = makeHandlers({
      session: null,
      metaFilePath: join(dir, "vanished.jsonl"),
    });
    const res = makeRes();

    await handlers.handleGetConversation("sess-1", url, res);

    expect(res.statusCode).toBe(404);
    expect(invalidate).toHaveBeenCalledWith("sess-1");
  });

  it("invalidates the id the row is keyed by, not a Codex placeholder", async () => {
    // For Codex the request carries the placeholder session id while the row is
    // keyed by the bound rollout uuid, so invalidating the raw id deleted either
    // nothing or the wrong thing.
    const { handlers, invalidate } = makeHandlers({
      session: null,
      metaFilePath: join(dir, "vanished.jsonl"),
      lookupId: "01a06d8c-f2ae-7051-8434-f5a44985806e",
    });

    await handlers.handleGetConversation("sess-1", url, makeRes());

    expect(invalidate).toHaveBeenCalledWith("01a06d8c-f2ae-7051-8434-f5a44985806e");
  });
});
