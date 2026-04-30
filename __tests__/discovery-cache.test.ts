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
    baseUrl = `http://localhost:${port}`;
    server = new StreamerServer({ port, apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(port);
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
});
