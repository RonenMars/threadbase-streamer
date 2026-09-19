/**
 * GET /api/conversations/:id reports the real provider when the client asks
 * with the PTY placeholder UUID of a live Cursor/Codex session.
 *
 * The cache row is keyed by the bound transcript id, so a lookup by the
 * placeholder used to miss and coerceProviderForRunner(undefined) defaulted to
 * claude-code.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";
import { ConversationCache } from "../src/conversation-cache";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";

let dir: string;
let cache: ConversationCache;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-provider-placeholder-"));
  cache = ConversationCache.open(join(dir, "cache.db"));
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

async function providerFor(opts: {
  requestId: string;
  boundId: string;
  cacheProvider: string;
  managedProvider?: string;
}): Promise<string> {
  const path = join(dir, `${opts.boundId}.jsonl`);
  writeFileSync(path, "");
  cache
    .getDatabase()
    .prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, message_count, updated_at) VALUES (?, ?, ?, 1, 1)",
    )
    .run(opts.boundId, canonicalizeFilePath(path), opts.cacheProvider);

  const handlers = new ConversationHandlers({
    scannerManager: {
      ready: null,
      current: undefined,
      projectsDirs: () => [],
      newScanner: () => ({
        // No `provider` on the scanner conversation: the case that defaulted to Claude.
        parseSingleFilePage: async (fp: string) => ({
          conversation: {
            filePath: fp,
            messages: [],
            messageCount: 0,
            timestamp: "2026-09-19T00:00:00.000Z",
            projectPath: "/tmp/p",
          },
        }),
      }),
    },
    scanProfiles: undefined,
    sessionStore: {
      getManaged: (id: string) =>
        id === opts.requestId && opts.managedProvider ? { provider: opts.managedProvider } : null,
      listManaged: () => [],
    },
    ptyManager: { hasSession: () => false },
    cache: () => cache,
    log: () => ({ warn: vi.fn(), info: vi.fn() }),
    rejectIfWarmingUp: () => false,
    resolveConversationLookupId: (id: string) => (id === opts.requestId ? opts.boundId : id),
    findLiveSessionFilePath: () => path,
    isBoundConversationLive: () => false,
    trackCacheWrite: () => {},
  } as unknown as ConstructorParameters<typeof ConversationHandlers>[0]);

  const chunks: string[] = [];
  const res = {
    writeHead: vi.fn(),
    end: vi.fn((body?: string) => {
      if (body) chunks.push(body);
    }),
  } as unknown as ServerResponse;
  await handlers.handleGetConversation(
    opts.requestId,
    new URL(`http://localhost/api/conversations/${opts.requestId}`),
    res,
  );
  return JSON.parse(chunks.join("")).meta.provider;
}

describe("meta.provider when the request id is a PTY placeholder", () => {
  it("labels a live Cursor session cursor via the bound cache row", async () => {
    expect(
      await providerFor({
        requestId: "4367097c-7334-4905-a57f-8e0aa7b09ba6",
        boundId: "f22ba10f-30e9-40b6-b27e-e35974fd7bf3",
        cacheProvider: "cursor",
      }),
    ).toBe("cursor");
  });

  it("labels a Codex placeholder -> rollout pair codex-cli", async () => {
    expect(
      await providerFor({
        requestId: "11111111-1111-4111-8111-111111111111",
        boundId: "rollout-2026-09-19T00-00-00-abc",
        cacheProvider: "codex-cli",
      }),
    ).toBe("codex-cli");
  });

  it("prefers the live managed session's provider over the cache", async () => {
    expect(
      await providerFor({
        requestId: "22222222-2222-4222-8222-222222222222",
        boundId: "33333333-3333-4333-8333-333333333333",
        cacheProvider: "claude-code",
        managedProvider: "cursor",
      }),
    ).toBe("cursor");
  });
});
