// A running sub-agent's transcript must stream live to a client viewing it,
// even when the box is past the fs.watch ceiling (EMFILE) and its
// `<parent>/subagents/` dir produces no chokidar events at all. `?parent=` is
// the moment we learn a child is active, so it attaches the tail, and a poll
// (not chokidar) advances it.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { StreamerServer } from "../src/server";
import { SUBAGENT_ACTIVE_MS } from "../src/services/conversations/subagentInfo";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";

const API_KEY = "tb_test_subagent_live_tail";

function line(sessionId: string, text: string, cwd: string, extra: object = {}): string {
  return `${JSON.stringify({
    sessionId,
    type: "user",
    uuid: `u-${text}`,
    cwd,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
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

describe("sub-agent live tail from ?parent=", () => {
  let server: StreamerServer;
  let configDir: string;
  let cacheDir: string;
  let projectPath: string;
  let ws: WebSocket;
  let events: any[];
  const parentId = "bbbb2222-0000-0000-0000-00000000f001";
  let activePath: string;
  let finishedPath: string;
  const side = { isSidechain: true, agentId: "aactive000000001" };

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "tb-sub-tail-cfg-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-sub-tail-cache-"));
    projectPath = mkdtempSync(join(tmpdir(), "tb-sub-tail-proj-"));
    const projectDir = join(configDir, "projects", projectPath.replace(/[/\\:.]/g, "-"));
    const subagentDir = join(projectDir, parentId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(projectDir, `${parentId}.jsonl`), line(parentId, "parent", projectPath));
    activePath = join(subagentDir, "agent-aactive000000001.jsonl");
    finishedPath = join(subagentDir, "agent-afinished00000001.jsonl");
    writeFileSync(activePath, line(parentId, "active-first", projectPath, side));
    writeFileSync(
      finishedPath,
      `${JSON.stringify({
        sessionId: parentId,
        isSidechain: true,
        agentId: "afinished00000001",
        type: "user",
        uuid: "u-done",
        cwd: projectPath,
        timestamp: new Date(Date.now() - 90_000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "done" }] },
      })}\n`,
    );
    // Inactive (> SUBAGENT_ACTIVE_MS) yet inside the 120 s external-tail
    // recency window, so only the subagentActive gate keeps it untailed.
    const old = new Date(Date.now() - 90_000);
    utimesSync(finishedPath, old, old);

    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [{ id: "test", label: "test", configDir, enabled: true, emoji: "🧪" }],
      scannerPersistent: false,
      codexRoots: [],
      featureFlags: { subagentSessions: true },
    });
    await server.listen(0, { awaitReady: true });
    // Mimic the EMFILE box: the directory watcher delivers nothing.
    (server as any).fileWatcher.unwatchDirectory(join(configDir, "projects"));

    events = [];
    ws = new WebSocket(`ws://localhost:${server.port}/ws?key=${API_KEY}`);
    ws.on("message", (d) => events.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
  });

  afterEach(async () => {
    ws.close();
    await server.close();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  });

  const tails = (): Map<string, unknown> => (server as any).externalTails;

  async function listChildren(): Promise<any[]> {
    const res = await fetch(
      `http://localhost:${server.port}/api/conversations?parent=${parentId}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()).conversations;
  }

  it("tails an active child and pushes its new lines with no chokidar event", async () => {
    const children = await listChildren();
    const active = children.find((c) => c.filePath === activePath);
    expect(active?.subagentActive).toBe(true);
    expect(tails().has(canonicalizeFilePath(activePath))).toBe(true);
    expect(tails().has(canonicalizeFilePath(finishedPath))).toBe(false);

    // Silence the per-file watch too: only the poll can deliver now.
    const watched = (server as any).fileWatcher.files.get(canonicalizeFilePath(activePath));
    watched.watcher.removeAllListeners("change");
    watched.watcher.removeAllListeners("add");

    appendFileSync(activePath, line(parentId, "LIVE-MARKER", projectPath, side));
    expect(
      await waitFor(() =>
        events.some(
          (e) =>
            e.type === "conversation_events" &&
            e.sessionId === active.id &&
            e.lines.join("").includes("LIVE-MARKER"),
        ),
      ),
    ).toBe(true);
  });

  it("releases the tail once the child stops writing", async () => {
    await listChildren();
    const manager = (server as any).externalTailManager;
    expect(tails().has(canonicalizeFilePath(activePath))).toBe(true);
    manager.pollSubagentTails(Date.now() + SUBAGENT_ACTIVE_MS + 1_000);
    expect(tails().size).toBe(0);
    expect((server as any).fileWatcher.files.has(canonicalizeFilePath(activePath))).toBe(false);
    expect(manager.subagentPollTimer).toBeNull();
  });
});
