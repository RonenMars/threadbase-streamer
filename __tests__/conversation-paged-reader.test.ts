/**
 * #505: a paged GET reads a bounded page through the scanner instead of
 * parsing the whole conversation into memory first.
 *
 * `fixtures/paged-reader/golden.json` was recorded from the full-read
 * implementation (RECORD_505=1) over a 300-message Claude conversation and a
 * Codex rollout whose head is two injected-context lines. The bounded reader
 * has to reproduce every body byte for byte; the spies prove it is the one
 * answering, and the freshness tests prove it does not serve a snapshot.
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationScanner } from "@threadbase-sh/scanner";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";
import { getLogger } from "../src/logger";
import { ScannerManager } from "../src/scanner-manager";
import { SessionStore } from "../src/session-store";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures/paged-reader/golden.json");
const CLAUDE_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const CODEX_ID = "bbbbbbbb-1111-4222-8333-444444444444";

const CLAUDE_QUERIES = [
  "msg_limit=80",
  "msg_limit=80&before_index=220",
  "msg_limit=120&before_index=100",
  "msg_limit=80&before_index=9999",
  "msg_limit=80&before_index=0",
  "msg_limit=80&before_index=-5",
  "msg_limit=500",
  "msg_limit=7&max_bytes=400",
];
const CODEX_QUERIES = [
  "msg_limit=80",
  "msg_limit=3",
  "msg_limit=3&before_index=5",
  "msg_limit=3&before_index=999",
];

let dir: string;
let claudeFile: string;
let codexFile: string;
let scanner: ConversationScanner;
let manager: ScannerManager;

const claudeLine = (i: number) =>
  `${JSON.stringify({
    type: i % 2 === 0 ? "user" : "assistant",
    uuid: `pr-${i}`,
    timestamp: `2026-06-05T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
    sessionId: CLAUDE_ID,
    cwd: dir,
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content:
        i % 10 === 1
          ? [
              { type: "text", text: `reply ${i}` },
              { type: "tool_use", id: `tu-${i}`, name: "Read", input: { path: `/f${i}` } },
            ]
          : [{ type: "text", text: `message ${i}` }],
    },
  })}\n`;

const turnDuration = (i: number) =>
  `${JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 100 + i, messageCount: i, uuid: `td-${i}` })}\n`;

const codexMessage = (second: number, role: string, text: string) =>
  `${JSON.stringify({
    timestamp: `2026-09-05T12:00:${String(second).padStart(2, "0")}.000Z`,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  })}\n`;

const AGENTS = "# AGENTS.md instructions\n\n<INSTRUCTIONS>project</INSTRUCTIONS>";
const ARGV = "You are working within the project boundary: /tmp/p";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tb-paged-reader-"));
  const project = join(dir, "projects", "-tmp-paged");
  mkdirSync(project, { recursive: true });
  claudeFile = join(project, `${CLAUDE_ID}.jsonl`);
  let claude = "";
  for (let i = 0; i < 300; i++) {
    claude += claudeLine(i);
    if (i % 100 === 99) claude += turnDuration(i);
  }
  writeFileSync(claudeFile, claude);

  codexFile = join(dir, `rollout-2026-09-05T12-00-00-${CODEX_ID}.jsonl`);
  let codex = `${JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID, cwd: dir } })}\n`;
  codex += codexMessage(1, "user", AGENTS) + codexMessage(2, "user", ARGV);
  for (let i = 0; i < 8; i++)
    codex += codexMessage(3 + i, i % 2 === 0 ? "user" : "assistant", `codex turn ${i}`);
  writeFileSync(codexFile, codex);

  scanner = new ConversationScanner({ persistent: false });
  manager = new ScannerManager({
    scanProfiles: [{ id: "p", label: "p", configDir: dir, enabled: true, emoji: "p" }],
    codexRoots: [dir],
    cursorRoots: [],
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
  await scanner.scan({
    profiles: [{ id: "p", label: "p", configDir: dir, enabled: true, emoji: "p" }],
    providers: ["claude-code", "codex-cli"],
    codexRoots: [dir],
  });
  manager.adoptIfUnclaimed(scanner);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await manager.close();
  rmSync(dir, { recursive: true, force: true });
});

function handlers() {
  return new ConversationHandlers({
    scannerManager: manager,
    sessionStore: new SessionStore(),
    ptyManager: { hasSession: () => false },
    cache: () => null,
    log: () => getLogger("server"),
    rejectIfWarmingUp: () => false,
    resolveConversationLookupId: (id: string) => id,
    findLiveSessionFilePath: () => null,
    isBoundConversationLive: () => false,
    trackCacheWrite: () => {},
  } as unknown as ConstructorParameters<typeof ConversationHandlers>[0]);
}

async function get(id: string, query: string, ifNoneMatch?: string) {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => {
      status = code;
      headers = h ?? {};
    },
    end: (chunk?: string) => {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  await handlers().handleGetConversation(
    id,
    new URL(`http://localhost/api/conversations/${id}?${query}`),
    res,
    ifNoneMatch,
  );
  // The temp dir is the only machine-specific part of a body. It is masked on
  // the parsed strings, not the raw body, because JSON escapes a Windows path's
  // backslashes; the separators after it are then forward slashes on every OS.
  // The project name is the tail of that path, in a shape that differs per OS,
  // so it is masked too.
  const mask = (v: unknown): unknown =>
    typeof v === "string" && v.includes(dir)
      ? v.split(dir).join("<tmp>").replaceAll("\\", "/")
      : Array.isArray(v)
        ? v.map(mask)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]))
          : v;
  const parsed = body ? (mask(JSON.parse(body)) as any) : null;
  if (parsed?.meta) {
    for (const key of ["project_name", "projectName"]) parsed.meta[key] = "<project>";
  }
  return { status, etag: headers.ETag, body: parsed };
}

describe("bounded paged reads (#505)", () => {
  it("matches the recorded full-read bodies for Claude and Codex", async () => {
    const out: Record<string, unknown> = {};
    for (const q of CLAUDE_QUERIES) out[`claude?${q}`] = (await get(CLAUDE_ID, q)).body;
    for (const q of CODEX_QUERIES) out[`codex?${q}`] = (await get(CODEX_ID, q)).body;
    if (process.env.RECORD_505) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}\n`);
      return;
    }
    expect(out).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  });

  it("answers a tail page from the scanner page, not a full read", async () => {
    const page = vi.spyOn(scanner, "getConversationPage");
    const full = vi.spyOn(scanner, "getConversation");
    const parse = vi.spyOn(scanner, "parseSingleFilePage");
    const r = await get(CLAUDE_ID, "msg_limit=80");
    expect(r.status).toBe(200);
    expect(r.body.messages).toHaveLength(80);
    expect(page).toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("hands the scanner the streamer's injected-prompt check, not only its own", async () => {
    const r = await get(CODEX_ID, "msg_limit=80");
    // The argv prompt is the streamer's own; the scanner's default would keep it.
    expect(r.body.messages[0]).toMatchObject({ message_index: 0, text: "codex turn 0" });
    expect(r.body.message_pagination.total).toBe(8);
  });

  it("falls back to the full read when the scanner does not know the id", async () => {
    vi.spyOn(scanner, "getConversationPage").mockResolvedValue(null);
    const r = await get(CLAUDE_ID, "msg_limit=80");
    expect(r.status).toBe(200);
    expect(r.body.messages).toHaveLength(80);
    expect(r.body.message_pagination.total).toBe(300);
  });

  it("sees a line appended to a Claude transcript on the next page", async () => {
    const before = await get(CLAUDE_ID, "msg_limit=80");
    expect(before.body.message_pagination.total).toBe(300);
    appendFileSync(claudeFile, claudeLine(300));
    const after = await get(CLAUDE_ID, "msg_limit=80");
    expect(after.body.message_pagination.total).toBe(301);
    expect(after.body.messages.at(-1)).toMatchObject({ message_index: 300, text: "message 300" });
    expect(after.body.meta.message_count).toBe(301);
    expect(after.etag).not.toBe(before.etag);
  });

  it("changes the ETag for an append that leaves the newest timestamp alone", async () => {
    const before = await get(CLAUDE_ID, "msg_limit=80");
    const sameSecond = JSON.parse(claudeLine(299));
    sameSecond.uuid = "pr-same-second";
    appendFileSync(claudeFile, `${JSON.stringify(sameSecond)}\n`);
    const after = await get(CLAUDE_ID, "msg_limit=80");
    expect(after.body.message_pagination.total).toBe(301);
    expect(after.etag).not.toBe(before.etag);
  });

  it("sees a line appended to a Codex rollout on the next page", async () => {
    const before = await get(CODEX_ID, "msg_limit=80");
    appendFileSync(codexFile, codexMessage(30, "assistant", "codex late"));
    const after = await get(CODEX_ID, "msg_limit=80");
    expect(after.body.message_pagination.total).toBe(9);
    expect(after.body.messages.at(-1)).toMatchObject({ message_index: 8, text: "codex late" });
    expect(after.etag).not.toBe(before.etag);
  });

  it("still answers 304 to a matching If-None-Match on the first page", async () => {
    const first = await get(CLAUDE_ID, "msg_limit=80");
    const second = await get(CLAUDE_ID, "msg_limit=80", first.etag);
    expect(second.status).toBe(304);
  });
});
