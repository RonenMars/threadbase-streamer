// P2.2 — external (non-PTY) live tails.
//
// A JSONL written by an external agent (a terminal `claude`, another streamer)
// gets its own tail so mobile is PUSHED transcript lines for it. The push reuses
// the exact shapes mobile already consumes (conversation_events + the legacy
// per-line conversation_event), keyed by the conversation UUID — and must never
// emit any PTY-only event (terminal_output / terminal_replay / session_ready /
// session_update) or a question card for it.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import type { StreamerServer } from "../src/server";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const API_KEY = "tb_test_external_tails";

// A user message line as Claude writes it into the project JSONL.
function userLine(convId: string, text: string, projectPath: string, ts: string): string {
  return `${JSON.stringify({
    sessionId: convId,
    type: "user",
    uuid: `u-${text}`,
    cwd: projectPath,
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("external live tails", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;
  let configDir: string;
  let cacheDir: string;
  let projectPath: string;
  let projectDir: string;
  let ws: WebSocket;
  let events: any[];

  beforeEach(async () => {
    const { StreamerServer } = await import("../src/server");
    port = await getRandomPort();
    baseUrl = `http://localhost:${port}`;

    configDir = mkdtempSync(join(tmpdir(), "tb-ext-tail-cfg-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-ext-tail-cache-"));
    projectPath = mkdtempSync(join(tmpdir(), "tb-ext-tail-proj-"));
    // The project dir must exist before listen(): watchDirectory() is wired at
    // startup against the profile's projects/ root.
    projectDir = join(configDir, "projects", projectPath.replace(/[/\\:.]/g, "-"));
    mkdirSync(projectDir, { recursive: true });

    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [{ id: "test", label: "test", configDir, enabled: true, emoji: "🧪" }],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);

    events = [];
    ws = new WebSocket(`ws://localhost:${port}/ws?key=${API_KEY}`);
    ws.on("message", (d) => {
      try {
        events.push(JSON.parse(d.toString()));
      } catch {
        /* ignore non-JSON */
      }
    });
    await new Promise<void>((r) => ws.on("open", () => r()));
    // chokidar's directory watcher runs an initial scan with ignoreInitial:true;
    // a file created before that scan settles never produces an "add" event.
    await new Promise((r) => setTimeout(r, 1500));
  });

  afterEach(async () => {
    ws.close();
    await server.close();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  });

  function externalTails(): Map<string, { conversationId: string; lastActivityAt: number }> {
    return (server as any).externalTails;
  }

  it("pushes conversation_events keyed by the conversation UUID for an external append", async () => {
    const convId = "aaaa1111-0000-0000-0000-00000000e001";
    const filePath = join(projectDir, `${convId}.jsonl`);

    // Creating the file is what makes the directory watcher notice it; the tail
    // attaches at EOF, so it's the NEXT append that streams.
    writeFileSync(filePath, userLine(convId, "first", projectPath, "2026-07-21T10:00:00.000Z"));
    expect(await waitFor(() => externalTails().size === 1)).toBe(true);

    appendFileSync(filePath, userLine(convId, "second", projectPath, "2026-07-21T10:00:01.000Z"));

    expect(
      await waitFor(() =>
        events.some((e) => e.type === "conversation_events" && e.sessionId === convId),
      ),
    ).toBe(true);

    const batched = events.find((e) => e.type === "conversation_events");
    expect(batched.sessionId).toBe(convId);
    expect(batched.lines.join("")).toContain("second");
    // Legacy per-line shape still ships for older clients.
    expect(events.some((e) => e.type === "conversation_event" && e.sessionId === convId)).toBe(
      true,
    );

    // No PTY-only event may ever be emitted for an external session — a
    // session_update keyed by a conversation UUID would mint a phantom session
    // row in the mobile cache.
    for (const type of [
      "terminal_output",
      "terminal_replay",
      "session_ready",
      "session_update",
      "question",
    ]) {
      expect(events.some((e) => e.type === type)).toBe(false);
    }
  });

  it("emits conversation_updated with ownership=external and refreshes the list row without ?refresh=1", async () => {
    const convId = "aaaa1111-0000-0000-0000-00000000e002";
    const filePath = join(projectDir, `${convId}.jsonl`);

    writeFileSync(filePath, userLine(convId, "first", projectPath, "2026-07-21T11:00:00.000Z"));
    expect(await waitFor(() => externalTails().size === 1)).toBe(true);

    appendFileSync(filePath, userLine(convId, "second", projectPath, "2026-07-21T11:00:05.000Z"));

    expect(
      await waitFor(() =>
        events.some((e) => e.type === "conversation_updated" && e.conversationId === convId),
      ),
    ).toBe(true);

    const updated = events.find((e) => e.type === "conversation_updated");
    expect(updated.ownership).toBe("external");
    expect(updated.messageCount).toBeGreaterThanOrEqual(1);
    expect(updated.lastActivity).toBe("2026-07-21T11:00:05.000Z");

    // The list row is served fresh from the cache the tail just wrote — no
    // ?refresh=1 needed.
    const res = await fetch(`${baseUrl}/api/conversations?limit=50&offset=0`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ id: string }> };
    expect(body.conversations.some((c) => c.id === convId)).toBe(true);
  });

  it("never derives a question card from an external tail (no PTY can answer it)", async () => {
    const convId = "aaaa1111-0000-0000-0000-00000000e003";
    const filePath = join(projectDir, `${convId}.jsonl`);
    const questionLine = `${JSON.stringify({
      sessionId: convId,
      type: "assistant",
      uuid: "q-1",
      cwd: projectPath,
      timestamp: "2026-07-21T12:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_external",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Deploy to prod?",
                  header: "H",
                  options: [{ label: "yes", description: "" }],
                },
              ],
            },
          },
        ],
      },
    })}\n`;

    writeFileSync(filePath, userLine(convId, "first", projectPath, "2026-07-21T12:00:00.000Z"));
    expect(await waitFor(() => externalTails().size === 1)).toBe(true);

    appendFileSync(filePath, questionLine);
    expect(
      await waitFor(() =>
        events.some((e) => e.type === "conversation_events" && e.sessionId === convId),
      ),
    ).toBe(true);

    expect(events.some((e) => e.type === "question")).toBe(false);
    expect((server as any).pendingQuestions.size).toBe(0);
  });

  it("does not attach an external tail for a file a managed session already owns", async () => {
    const convId = "aaaa1111-0000-0000-0000-00000000e004";
    const filePath = join(projectDir, `${convId}.jsonl`);
    writeFileSync(filePath, userLine(convId, "first", projectPath, "2026-07-21T13:00:00.000Z"));
    (server as any).sessionFileMap.set("managed-session", filePath);

    (server as any).maybeAttachExternalTail(filePath);

    expect(externalTails().size).toBe(0);
  });

  it("does not attach an external tail for a JSONL that has not been touched recently", async () => {
    const { utimesSync } = await import("fs");
    const convId = "aaaa1111-0000-0000-0000-00000000e005";
    const filePath = join(projectDir, `${convId}.jsonl`);
    writeFileSync(filePath, userLine(convId, "old", projectPath, "2026-07-21T14:00:00.000Z"));
    const stale = new Date(Date.now() - 10 * 60_000);
    utimesSync(filePath, stale, stale);

    (server as any).maybeAttachExternalTail(filePath);

    expect(externalTails().size).toBe(0);
  });

  it("caps concurrent external tails and evicts the least recently active", async () => {
    const { EXTERNAL_TAIL_MAX } = await import("../src/server");
    const unwatch = vi.spyOn((server as any).fileWatcher, "unwatch").mockImplementation(() => {});

    const tails = externalTails();
    const now = Date.now();
    for (let i = 0; i < EXTERNAL_TAIL_MAX; i++) {
      tails.set(`/tmp/ext-${i}.jsonl`, {
        conversationId: `ext-${i}`,
        // ext-7 is the least recently active.
        lastActivityAt: i === 7 ? now - 60_000 : now - i,
      });
    }
    expect(tails.size).toBe(EXTERNAL_TAIL_MAX);

    (server as any).evictExternalTailsIfNeeded();

    expect(tails.size).toBe(EXTERNAL_TAIL_MAX - 1);
    expect(tails.has("/tmp/ext-7.jsonl")).toBe(false);
    expect(unwatch).toHaveBeenCalledWith("/tmp/ext-7.jsonl");
    unwatch.mockRestore();
  });

  it("detaches an external tail after the idle window", async () => {
    const { EXTERNAL_TAIL_IDLE_MS } = await import("../src/server");
    const unwatch = vi.spyOn((server as any).fileWatcher, "unwatch").mockImplementation(() => {});

    const tails = externalTails();
    const now = Date.now();
    tails.set("/tmp/idle.jsonl", {
      conversationId: "idle",
      lastActivityAt: now - EXTERNAL_TAIL_IDLE_MS - 1,
    });
    tails.set("/tmp/busy.jsonl", { conversationId: "busy", lastActivityAt: now });

    (server as any).sweepIdleExternalTails(now);

    expect(tails.has("/tmp/idle.jsonl")).toBe(false);
    expect(tails.has("/tmp/busy.jsonl")).toBe(true);
    expect(unwatch).toHaveBeenCalledWith("/tmp/idle.jsonl");
    unwatch.mockRestore();
  });

  it("detaches an external tail when its JSONL is deleted", async () => {
    const convId = "aaaa1111-0000-0000-0000-00000000e006";
    const filePath = join(projectDir, `${convId}.jsonl`);
    writeFileSync(filePath, userLine(convId, "first", projectPath, "2026-07-21T15:00:00.000Z"));
    expect(await waitFor(() => externalTails().size === 1)).toBe(true);

    rmSync(filePath, { force: true });

    expect(await waitFor(() => externalTails().size === 0)).toBe(true);
  });
});
