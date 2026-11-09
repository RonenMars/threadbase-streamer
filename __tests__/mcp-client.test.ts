/**
 * Unit checks on the MCP shim's streamer client that the e2e harness cannot
 * reach: the loopback guard on an arbitrary base URL, and key redaction on a
 * path where the key would otherwise flow into a tool result. Drives the
 * server through the SDK's in-memory transport with an injected fetch.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../cli/mcp";

const KEY = "tb_unit_test_key_0123456789abcdef";

// `{}` means no key: a default parameter would silently re-apply KEY on an explicit undefined.
async function connect(fetchFn: typeof fetch, { apiKey }: { apiKey?: string } = { apiKey: KEY }) {
  const server = createMcpServer({ baseUrl: "http://127.0.0.1:1", apiKey, fetchFn });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "mcp-client-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function callText(client: Client, name: string) {
  const res = await client.callTool({ name, arguments: {} });
  const content = res.content as Array<{ text?: string }>;
  return { isError: res.isError === true, text: content.map((c) => c.text ?? "").join("\n") };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("mcp streamer client", () => {
  describe("loopback guard", () => {
    it.each(["http://127.0.0.1:8766", "http://localhost:8766", "http://[::1]:8766"])(
      "accepts %s",
      (baseUrl) => {
        expect(() => createMcpServer({ baseUrl, apiKey: KEY, fetchFn: fetch })).not.toThrow();
      },
    );

    it.each(["http://example.com:8766", "http://0.0.0.0:8766", "http://192.168.1.10:8766"])(
      "refuses %s",
      (baseUrl) => {
        expect(() => createMcpServer({ baseUrl, apiKey: KEY, fetchFn: fetch })).toThrow(/loopback/);
      },
    );
  });

  it("sends the key as a Bearer credential", async () => {
    const seen: string[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      seen.push(String(new Headers(init?.headers).get("authorization")));
      return String(url).endsWith("/api/providers")
        ? json({ providers: [] })
        : json({ version: "1.2.3" });
    };
    const client = await connect(fetchFn);
    const { isError, text } = await callText(client, "streamer_info");
    expect(isError).toBe(false);
    expect(JSON.parse(text).version).toBe("1.2.3");
    expect(seen.length).toBeGreaterThan(0);
    for (const auth of seen) expect(auth).toBe(`Bearer ${KEY}`);
  });

  it("redacts the key from an error body the streamer echoes back", async () => {
    const fetchFn: typeof fetch = async () => json({ error: `rejected ${KEY} here` }, 500);
    const client = await connect(fetchFn);
    const { isError, text } = await callText(client, "streamer_info");
    expect(isError).toBe(true);
    expect(text).not.toContain(KEY);
    expect(text).toContain("[redacted]");
  });

  it("reports a missing key as a one-line set-key error without calling the streamer", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls++;
      return json({});
    };
    const client = await connect(fetchFn, {});
    const { isError, text } = await callText(client, "streamer_info");
    expect(isError).toBe(true);
    expect(text).toContain("set-key");
    expect(text).not.toContain("\n");
    expect(calls).toBe(0);
  });
});
