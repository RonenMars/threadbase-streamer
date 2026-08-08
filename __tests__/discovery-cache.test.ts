import { createServer } from "http";
import { vi } from "vitest";

vi.mock("../src/process-discovery", () => ({
  discoverClaudeProcesses: vi.fn().mockReturnValue([]),
}));

import { discoverClaudeProcesses } from "../src/process-discovery";
import { StreamerServer } from "../src/server";

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

const API_KEY = "tb_test_key_discovery_cache";

describe("GET /api/sessions — discovery TTL cache", () => {
  let server: StreamerServer;
  let baseUrl: string;

  beforeEach(async () => {
    vi.mocked(discoverClaudeProcesses).mockClear();
    const port = await getRandomPort();
    server = new StreamerServer({ port, apiKey: API_KEY, localNoAuth: false, verbose: false });
    // awaitReady is required now that /api/sessions rejects with 503 while a
    // warm-up is in flight: without it both fetches below land inside the
    // warm-up window, get rejected, and discovery is never reached.
    await server.listen(port, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it("calls discoverClaudeProcesses only once for two requests within 5s", async () => {
    const headers = { Authorization: `Bearer ${API_KEY}` };

    await fetch(`${baseUrl}/api/sessions`, { headers });
    await fetch(`${baseUrl}/api/sessions`, { headers });

    expect(vi.mocked(discoverClaudeProcesses)).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight discovery across concurrent requests", async () => {
    // Without single-flight, mobile retry storms each spawn a full Windows
    // CIM scan (observed: many overlapping GET /api/sessions at 80–100s).
    let release!: (value: never[]) => void;
    const gate = new Promise<never[]>((resolve) => {
      release = resolve;
    });
    vi.mocked(discoverClaudeProcesses).mockImplementation(() => gate);

    const headers = { Authorization: `Bearer ${API_KEY}` };
    const first = fetch(`${baseUrl}/api/sessions`, { headers });
    const second = fetch(`${baseUrl}/api/sessions`, { headers });

    // Both handlers must reach the discovery await before we release it.
    await vi.waitFor(() => {
      expect(vi.mocked(discoverClaudeProcesses)).toHaveBeenCalledTimes(1);
    });

    release([]);
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(vi.mocked(discoverClaudeProcesses)).toHaveBeenCalledTimes(1);
  });
});
