import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamerServer } from "../src/server";
import * as backgroundAgents from "../src/services/conversations/backgroundAgents";

const { deriveClaudeBackgroundAgents, readClaudeBackgroundAgents } = backgroundAgents;

/**
 * Background agents of a Claude conversation (#1072). The fixture is raw
 * records from two real transcripts (ids, paths and prompts scrubbed): three
 * async launches — two end `completed`, one `killed` (the user stopped it) —
 * plus the completion of a fourth agent whose launch is not in the file.
 */
const FIXTURE = join(__dirname, "fixtures", "background-agents.jsonl");
const fixtureLines = () => readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);

describe("deriveClaudeBackgroundAgents", () => {
  it("pairs each launch with its completion, in launch order", () => {
    const agents = deriveClaudeBackgroundAgents(fixtureLines());
    expect(agents.map((a) => [a.agentId, a.status])).toEqual([
      ["abb7b87f57127eba4", "completed"],
      ["a7f741584bf7cb507", "completed"],
      ["ab443c2bb33cff955", "stopped"],
    ]);
  });

  it("maps killed to stopped and carries the launch and completion fields", () => {
    const stopped = deriveClaudeBackgroundAgents(fixtureLines()).find(
      (a) => a.agentId === "ab443c2bb33cff955",
    );
    expect(stopped).toMatchObject({
      description: "Scan services",
      agentType: "Explore",
      status: "stopped",
      toolCallId: "toolu_01DEcAq4J9gNWfepLE9f4vAZ",
      summary: 'Agent "example" was stopped by user',
    });
    expect(stopped?.launchedAt).toMatch(/^2026-08-15T/);
    expect(stopped?.completedAt).toMatch(/^2026-08-15T/);
  });

  it("ignores a completion whose launch is not in the file", () => {
    const agents = deriveClaudeBackgroundAgents(fixtureLines());
    expect(agents.map((a) => a.agentId)).not.toContain("ac97e3c866e0f1621");
    expect(agents).toHaveLength(3);
  });

  it("leaves an agent with no completion running, and passes unknown states through", () => {
    const lines = fixtureLines();
    const launchesOnly = lines.filter((l) => !l.includes("queue-operation"));
    expect(deriveClaudeBackgroundAgents(launchesOnly).map((a) => a.status)).toEqual([
      "running",
      "running",
      "running",
    ]);
    const odd = lines.map((l) => l.replace("<status>killed</status>", "<status>paused</status>"));
    expect(deriveClaudeBackgroundAgents(odd).at(-1)?.status).toBe("paused");
  });

  it("counts the user-record copy of a notification once (only queue-operation is read)", () => {
    const delivered = JSON.stringify({
      type: "user",
      timestamp: "2099-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content:
          "<task-notification>\n<task-id>abb7b87f57127eba4</task-id>\n<status>failed</status>\n</task-notification>",
      },
    });
    const agent = deriveClaudeBackgroundAgents([...fixtureLines(), delivered])[0];
    expect(agent.status).toBe("completed");
  });

  it("skips lines that are not JSON", () => {
    expect(
      deriveClaudeBackgroundAgents(['"async_launched" {oops', ...fixtureLines()]),
    ).toHaveLength(3);
  });
});

describe("deriveClaudeBackgroundAgents, repeated records", () => {
  it("reads only enqueue records of the queue", () => {
    const removed = JSON.stringify({
      type: "queue-operation",
      operation: "remove",
      timestamp: "2099-01-01T00:00:00.000Z",
      content:
        "<task-notification>\n<task-id>abb7b87f57127eba4</task-id>\n<status>failed</status>\n</task-notification>",
    });
    expect(deriveClaudeBackgroundAgents([...fixtureLines(), removed])[0].status).toBe("completed");
  });

  it("keeps the first launch when the same agent is launched twice in the file", () => {
    const lines = fixtureLines();
    const launch = lines.find(
      (l) => l.includes("async_launched") && l.includes("abb7b87f57127eba4"),
    ) as string;
    const agents = deriveClaudeBackgroundAgents([...lines, launch]);
    expect(agents).toHaveLength(3);
    expect(agents[0].status).toBe("completed");
  });
});

describe("readClaudeBackgroundAgents", () => {
  it("re-derives when the file changes, and reuses the result when it does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "threadbase-bg-agents-read-"));
    const file = join(dir, "c.jsonl");
    const lines = fixtureLines();
    const completions = lines.filter((l) => l.includes("queue-operation"));
    writeFileSync(file, `${lines.filter((l) => !completions.includes(l)).join("\n")}\n`);
    expect((await readClaudeBackgroundAgents(file)).map((a) => a.status)).toEqual([
      "running",
      "running",
      "running",
    ]);

    appendFileSync(file, `${completions.join("\n")}\n`);
    expect((await readClaudeBackgroundAgents(file)).map((a) => a.status)).toEqual([
      "completed",
      "completed",
      "stopped",
    ]);

    const first = await readClaudeBackgroundAgents(file);
    expect(await readClaudeBackgroundAgents(file)).toBe(first);
  });
});

describe("GET /api/conversations/:id?include=backgroundAgents", () => {
  const API_KEY = "tb_test_key_for_background_agents";
  const ID = "00000000-0000-4000-8000-000000000001"; // the fixture's own sessionId
  let server: StreamerServer;
  let port: number;
  let transcript: string;
  const CODEX_ID = "019edbc1-13a7-7fa1-80b4-7eafc270f03e";

  beforeAll(async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "threadbase-bg-agents-profile-"));
    const projDir = join(profileDir, "projects", "-tmp-bg-agents");
    mkdirSync(projDir, { recursive: true });
    transcript = join(projDir, `${ID}.jsonl`);
    copyFileSync(FIXTURE, transcript);
    // A Codex rollout beside the Claude transcript, to prove the provider gate.
    const codexRoot = join(mkdtempSync(join(tmpdir(), "threadbase-bg-agents-codex-")), "sessions");
    const codexDir = join(codexRoot, "2026", "06", "18");
    mkdirSync(codexDir, { recursive: true });
    copyFileSync(
      join(__dirname, "fixtures", "codex-rollout.jsonl"),
      join(codexDir, `rollout-2026-06-18T20-22-04-${CODEX_ID}.jsonl`),
    );
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: mkdtempSync(join(tmpdir(), "threadbase-bg-agents-cache-")),
      scanProfiles: [{ id: "bg", label: "Bg", configDir: profileDir, enabled: true, emoji: "🤖" }],
      codexRoots: [codexRoot],
      scannerPersistent: false,
    });
    await server.listen(0, { awaitReady: true });
    port = server.port;
  });

  afterAll(async () => {
    await server.close();
  });

  const get = (params: string, headers: Record<string, string> = {}) =>
    fetch(`http://localhost:${port}/api/conversations/${ID}${params}`, {
      headers: { Authorization: `Bearer ${API_KEY}`, ...headers },
    });

  it("adds the array when asked, and only then", async () => {
    const plain = (await (await get("")).json()) as Record<string, unknown>;
    expect(plain).not.toHaveProperty("backgroundAgents");

    const res = await get("?include=backgroundAgents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backgroundAgents: Array<{ agentId: string; status: string }>;
    };
    expect(body.backgroundAgents.map((a) => a.status)).toEqual([
      "completed",
      "completed",
      "stopped",
    ]);
  });

  it("accepts the token inside a comma list and ignores unknown ones", async () => {
    const body = (await (await get("?include=subagents,backgroundAgents")).json()) as {
      backgroundAgents?: unknown[];
    };
    expect(body.backgroundAgents).toHaveLength(3);
    const none = (await (await get("?include=nonsense")).json()) as Record<string, unknown>;
    expect(none).not.toHaveProperty("backgroundAgents");
  });

  it("leaves the default response byte-identical and never reads the file for it", async () => {
    const spy = vi.spyOn(backgroundAgents, "readClaudeBackgroundAgents");
    try {
      const before = await (await get("")).text();
      const withUnknown = await (await get("?include=nonsense")).text();
      expect(withUnknown).toBe(before);
      expect(spy).not.toHaveBeenCalled();
      await get("?include=backgroundAgents");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves a non-Claude conversation without the field, even when asked", async () => {
    const res = await fetch(
      `http://localhost:${port}/api/conversations/${CODEX_ID}?include=backgroundAgents`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { provider: string } };
    // The positive control: this really is the Codex conversation.
    expect(body.meta.provider).toBe("codex-cli");
    expect(body).not.toHaveProperty("backgroundAgents");
  });

  it("changes the ETag when only the file changes, so a 304 cannot hide a completion", async () => {
    const first = await get("?include=backgroundAgents");
    const etag = first.headers.get("etag") as string;
    expect((await get("?include=backgroundAgents", { "If-None-Match": etag })).status).toBe(304);

    // Same size and same messages; only the mtime moves.
    const { atime, mtime } = statSync(transcript);
    utimesSync(transcript, atime, new Date(mtime.getTime() + 5_000));
    const after = await get("?include=backgroundAgents", { "If-None-Match": etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
  });
});
