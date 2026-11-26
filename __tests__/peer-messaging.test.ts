import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
}));

import { discoverClaudeProcesses } from "../src/process-discovery";
import { StreamerServer } from "../src/server";
import { requiredCapability } from "../src/services/security/capabilities";
import { peerAddressFor, peerMentionFor } from "../src/session-store";
import type { DiscoveredProcess } from "../src/types";

const CONV = "9f66e9cd-2b55-40ea-81a7-327c27cc0024";
const OTHER = "ec943a8d-1e8b-4eeb-96f8-511a97481149";
const SOCK = "/tmp/example-socks/4242.sock";

function proc(overrides: Partial<DiscoveredProcess> = {}): DiscoveredProcess {
  return {
    pid: 4242,
    provider: "claude-code",
    projectPath: "/tmp/peer-msg-proj",
    projectName: "peer-msg-proj",
    branch: "main",
    conversationId: CONV,
    startedAt: new Date(),
    peerName: { name: "example-peer", source: "derived" },
    peerMessaging: { socketPath: SOCK, protocol: 1 },
    ...overrides,
  };
}

describe("peer mention and address", () => {
  it("inserts a bare @name for a word name and a quoted one otherwise", () => {
    expect(peerMentionFor("example-peer_2")).toBe("@example-peer_2");
    expect(peerMentionFor("name slug developer")).toBe('@"name slug developer"');
  });

  it("offers no mention for a name the quoted form cannot carry", () => {
    for (const name of ['say "hi"', "line\nbreak", ""]) {
      expect(peerMentionFor(name)).toBeUndefined();
    }
  });

  it("percent-encodes the socket path the way the CLI does", () => {
    expect(peerAddressFor("/tmp/example-socks/4242.sock")).toBe("uds:/tmp/example-socks/4242.sock");
    expect(peerAddressFor("/tmp/a b/é.sock")).toBe("uds:/tmp/a%20b/%C3%A9.sock");
  });
});

describe("GET /api/sessions — peer messaging", () => {
  const API_KEY = "tb_test_key_peer_messaging";
  let server: StreamerServer;

  async function start(peerMessaging: boolean, procs: DiscoveredProcess[]): Promise<void> {
    vi.mocked(discoverClaudeProcesses).mockReset();
    vi.mocked(discoverClaudeProcesses).mockResolvedValue(procs);
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      featureFlags: { peerMessaging },
    });
    await server.listen(0, { awaitReady: true });
  }

  afterEach(async () => {
    await server.close();
  });

  async function list(): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`http://localhost:${server.port}/api/sessions`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await res.json()) as unknown;
    return (Array.isArray(body) ? body : (body as { sessions: [] }).sessions) as Array<
      Record<string, unknown>
    >;
  }

  it("marks a live peer with protocol 1 messageable, with its mention and address", async () => {
    await start(true, [proc()]);
    const row = (await list()).find((s) => s.id === CONV);
    expect(row).toMatchObject({
      canMessage: true,
      peerMention: "@example-peer",
      peerAddress: `uds:${SOCK}`,
    });
  });

  it("adds nothing while the flag is off", async () => {
    await start(false, [proc()]);
    const row = (await list()).find((s) => s.id === CONV);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("canMessage");
    expect(row).not.toHaveProperty("peerMention");
    expect(row).not.toHaveProperty("peerAddress");
  });

  it("reports canMessage false for an unchecked protocol or no socket", async () => {
    await start(true, [
      proc({ peerMessaging: { socketPath: SOCK, protocol: 2 } }),
      proc({ pid: 4343, conversationId: OTHER, peerMessaging: undefined }),
    ]);
    const rows = await list();
    for (const id of [CONV, OTHER]) {
      const row = rows.find((s) => s.id === id);
      expect(row).toMatchObject({ canMessage: false });
      expect(row).not.toHaveProperty("peerAddress");
      expect(row).not.toHaveProperty("peerMention");
    }
  });

  it("adds nothing to a session that is not Claude", async () => {
    await start(true, [proc({ provider: "codex" })]);
    const row = (await list()).find((s) => s.id === CONV);
    expect(row).toMatchObject({ provider: "codex" });
    expect(row).not.toHaveProperty("canMessage");
  });

  it("covers the streamer's own PTY child, by its bound conversation", async () => {
    await start(true, [proc()]);
    const MANAGED_ID = "3c0a7d52-6c1e-4d0a-9b8e-2f1f3c4d5e6f";
    (server as any).sessionStore.addManaged({
      id: MANAGED_ID,
      provider: "claude-code",
      projectPath: "/tmp/peer-msg-proj",
      projectName: "peer-msg-proj",
      branch: "main",
      status: "waiting_input",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      boundConversationId: CONV,
    });
    const ptyManager = (server as any).sessionHandlers.deps.ptyManager;
    vi.spyOn(ptyManager, "listSessions").mockReturnValue([{ id: MANAGED_ID }] as never);
    vi.spyOn(ptyManager, "getPid").mockReturnValue(4242);
    const row = (await list()).find((s) => s.id === MANAGED_ID);
    expect(row).toMatchObject({ canMessage: true, peerAddress: `uds:${SOCK}` });
  });
});

describe("GET /api/peers", () => {
  const API_KEY = "tb_test_key_peers_endpoint";
  let server: StreamerServer;

  async function peers(peerMessaging: boolean, procs: DiscoveredProcess[]) {
    vi.mocked(discoverClaudeProcesses).mockReset();
    vi.mocked(discoverClaudeProcesses).mockResolvedValue(procs);
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      featureFlags: { peerMessaging },
    });
    await server.listen(0, { awaitReady: true });
    const res = await fetch(`http://localhost:${server.port}/api/peers`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    return { status: res.status, body: (await res.json()) as unknown };
  }

  afterEach(async () => {
    await server?.close();
  });

  it("is a history:read route", () => {
    expect(requiredCapability("/api/peers", "GET")).toBe("history:read");
  });

  it("lists only messageable Claude peers, with the fields mobile inserts", async () => {
    const { status, body } = await peers(true, [
      proc(),
      proc({ pid: 4343, conversationId: OTHER, peerMessaging: { socketPath: SOCK, protocol: 2 } }),
    ]);
    expect(status).toBe(200);
    expect(body).toEqual({
      peers: [
        {
          id: CONV,
          name: "example-peer",
          projectName: "peer-msg-proj",
          peerMention: "@example-peer",
          peerAddress: `uds:${SOCK}`,
        },
      ],
    });
  });

  it.each([
    ["its peer name over its session name", { conversationId: CONV }, "example-peer"],
    [
      "its session name when it has no peer name",
      { conversationId: "5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e", peerName: undefined },
      "example session",
    ],
  ])("names a peer by %s", async (_label, overrides, expected) => {
    vi.mocked(discoverClaudeProcesses).mockReset();
    vi.mocked(discoverClaudeProcesses).mockResolvedValue([proc(overrides)]);
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      featureFlags: { peerMessaging: true },
    });
    await server.listen(0, { awaitReady: true });
    const MANAGED_ID = "3c0a7d52-6c1e-4d0a-9b8e-2f1f3c4d5e6f";
    (server as any).sessionStore.addManaged({
      id: MANAGED_ID,
      provider: "claude-code",
      projectPath: "/tmp/peer-msg-proj",
      projectName: "peer-msg-proj",
      branch: "main",
      status: "waiting_input",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      boundConversationId: overrides.conversationId,
      sessionName: "example session",
    });
    const ptyManager = (server as any).sessionHandlers.deps.ptyManager;
    vi.spyOn(ptyManager, "listSessions").mockReturnValue([{ id: MANAGED_ID }] as never);
    vi.spyOn(ptyManager, "getPid").mockReturnValue(4242);
    const res = await fetch(`http://localhost:${server.port}/api/peers`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const { peers: rows } = (await res.json()) as { peers: Array<Record<string, unknown>> };
    expect(rows).toEqual([expect.objectContaining({ id: MANAGED_ID, name: expected })]);
  });

  it("answers an empty list while the flag is off", async () => {
    const { status, body } = await peers(false, [proc()]);
    expect(status).toBe(200);
    expect(body).toEqual({ peers: [] });
  });
});
