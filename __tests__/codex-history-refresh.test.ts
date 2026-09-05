import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationScanner } from "@threadbase-sh/scanner";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";
import { getLogger } from "../src/logger";
import { ScannerManager } from "../src/scanner-manager";
import { SessionStore } from "../src/session-store";

const require = createRequire(import.meta.url);
const CommonJsScanner = require("@threadbase-sh/scanner")
  .ConversationScanner as typeof ConversationScanner;
const ID = "11111111-2222-4333-8444-555555555555";
const scanOptions = { profiles: [], providers: ["codex-cli" as const] };

describe.each([
  ["ESM", ConversationScanner],
  ["CommonJS", CommonJsScanner],
] as const)("Codex history refresh (%s)", (_format, Scanner) => {
  let dir: string;
  let file: string;
  let scanner: ConversationScanner;
  let manager: ScannerManager;

  function turn(text: string, second: number): string {
    return `${JSON.stringify({
      timestamp: `2026-09-05T12:00:${String(second).padStart(2, "0")}.000Z`,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    })}\n`;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-codex-refresh-"));
    file = join(dir, `rollout-2026-09-05T12-00-00-${ID}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { id: ID, cwd: dir } })}\n${turn("first", 1)}`,
    );
    scanner = new Scanner({ persistent: false });
    manager = new ScannerManager({
      scanProfiles: [],
      codexRoots: [dir],
      directoryDebounceMs: 0,
      persistenceDisabled: true,
      cache: () => null,
      cacheMonitor: () => null,
      projectsRepo: () => null,
      conversationsRepo: () => null,
      cacheMetadataRepo: () => null,
      trackCacheWrite: () => {},
    });
    manager.track(scanner);
  });

  afterEach(async () => {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function history() {
    const handlers = new ConversationHandlers({
      scannerManager: manager,
      sessionStore: new SessionStore(),
      // No PTY, cache tail, or mobile transport can conceal a scanner miss.
      ptyManager: { hasSession: () => false },
      cache: () => null,
      log: () => getLogger("server"),
      rejectIfWarmingUp: () => false,
      resolveConversationLookupId: (id: string) => id,
      findLiveSessionFilePath: () => file,
      isBoundConversationLive: () => false,
      trackCacheWrite: () => {},
    } as ConstructorParameters<typeof ConversationHandlers>[0]);
    let status = 0;
    let body = "";
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (chunk: string) => {
        body = chunk;
      },
    } as unknown as ServerResponse;
    await handlers.handleGetConversation(
      ID,
      new URL(`http://localhost/api/conversations/${ID}?after_index=1&msg_limit=80`),
      res,
    );
    return { status, body: JSON.parse(body) };
  }

  it("keeps incremental history and the indexed conversation after turn refresh", async () => {
    await scanner.scan({ ...scanOptions, codexRoots: [dir] });
    manager.adoptIfUnclaimed(scanner);
    const before = await history();
    expect(before.status).toBe(200);
    expect(before.body.messages).toEqual([]);
    expect((await scanner.getConversation(ID))?.messages).toHaveLength(1);

    appendFileSync(file, turn("second", 2));
    await manager.refreshFileGuarded(scanner, file);

    const after = await history();
    expect(after.status).toBe(200);
    expect(after.body.messages).toMatchObject([{ message_index: 1, text: "second" }]);
    // The fallback alone must not hide refresh dropping the metadata/LRU entry.
    expect((await scanner.getConversation(ID))?.messages).toHaveLength(2);
  });

  it("serves cold incremental history without a scanner index", async () => {
    appendFileSync(file, turn("second", 2));
    const result = await history();
    expect(result.status).toBe(200);
    expect(result.body.messages).toMatchObject([{ message_index: 1, text: "second" }]);
    expect(manager.ready).toBeNull();
  });

  it.each([false, true])("reparses fresh Codex pages with persistent=%s", async (persistent) => {
    const reader = new Scanner({
      persistent: persistent ? { dbPath: join(dir, "index.db") } : false,
    });
    manager.track(reader);
    const before = await reader.parseSingleFilePage(file, "codex", { limit: 1 });
    expect(before?.messages.map((message) => message.text)).toEqual(["first"]);
    appendFileSync(file, turn("second", 2));
    const after = await reader.parseSingleFilePage(file, "codex", { limit: 1 });
    expect(after?.messages.map((message) => message.text)).toEqual(["second"]);
    expect(after?.total).toBe(2);
    expect(after?.fromIndex).toBe(1);
  });

  it("still removes a deleted rollout and returns 404", async () => {
    await scanner.scan({ ...scanOptions, codexRoots: [dir] });
    manager.adoptIfUnclaimed(scanner);
    expect((await history()).status).toBe(200);
    unlinkSync(file);
    await manager.refreshFileGuarded(scanner, file);
    expect(await scanner.getConversation(ID)).toBeNull();
    expect((await history()).status).toBe(404);
  });

  it("still parses and refreshes Claude transcripts", async () => {
    const project = join(dir, "projects", "fixture");
    mkdirSync(project, { recursive: true });
    const claudeFile = join(project, `${ID}.jsonl`);
    const claudeTurn = (text: string, uuid: string) =>
      `${JSON.stringify({
        type: "user",
        sessionId: ID,
        uuid,
        cwd: dir,
        timestamp: "2026-09-05T12:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`;
    writeFileSync(claudeFile, claudeTurn("first", "turn-1"));
    expect((await scanner.parseSingleFilePage(claudeFile, "default", { limit: 1 }))?.total).toBe(1);
    expect((await scanner.refreshFile(claudeFile))?.messageCount).toBe(1);
    appendFileSync(claudeFile, claudeTurn("second", "turn-2"));
    expect((await scanner.refreshFile(claudeFile))?.messageCount).toBe(2);
    expect((await scanner.getConversation(claudeFile))?.messages).toHaveLength(2);
  });
});
