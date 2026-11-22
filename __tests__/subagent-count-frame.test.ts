// A new sub-agent must reach a connected client as a `subagents_changed` frame
// carrying the parent's full count, so "Sub-agents (n)" moves without polling.
// The directory watcher is silenced (the EMFILE box), so the child is learned
// from ?parent=; the frame is what the client sees from that.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { StreamerServer } from "../src/server";

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

describe("subagents_changed frame", () => {
  let server: StreamerServer;
  let configDir: string;
  let cacheDir: string;
  let projectPath: string;
  let ws: WebSocket;
  let events: any[];
  const parentId = "cccc3333-0000-0000-0000-00000000f001";
  let projectDir: string;
  let activePath: string;
  let finishedPath: string;
  const side = { isSidechain: true, agentId: "aactive000000001" };

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "tb-sub-count-cfg-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-sub-count-cache-"));
    projectPath = mkdtempSync(join(tmpdir(), "tb-sub-count-proj-"));
    projectDir = join(configDir, "projects", projectPath.replace(/[/\\:.]/g, "-"));
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

  const countFrames = () => events.filter((e) => e.type === "subagents_changed");

  async function listChildren(): Promise<any[]> {
    const res = await fetch(
      `http://localhost:${server.port}/api/conversations?parent=${parentId}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(res.status).toBe(200);
    return (await res.json()).conversations;
  }

  it("pushes the full count when a new child appears, and stays quiet when nothing changed", async () => {
    expect(await listChildren()).toHaveLength(2);
    expect(
      await waitFor(() => countFrames().some((f) => f.parentId === parentId && f.total === 2)),
    ).toBe(true);

    const before = countFrames().length;
    await listChildren(); // unchanged children: scanner may re-upsert, count is the same
    await new Promise((r) => setTimeout(r, 800));
    expect(countFrames().length).toBe(before);

    const added = join(projectDir, parentId, "subagents", "agent-anew0000000001.jsonl");
    writeFileSync(
      added,
      line(parentId, "new-child", projectPath, { isSidechain: true, agentId: "anew0000000001" }),
    );
    expect(await listChildren()).toHaveLength(3);
    expect(
      await waitFor(() => countFrames().some((f) => f.parentId === parentId && f.total === 3)),
    ).toBe(true);
  });
});
