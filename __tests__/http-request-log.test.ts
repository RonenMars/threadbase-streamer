import { serve } from "@hono/node-server";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHonoApp, summarizeQuery } from "../src/api/app";
import type { ApiDeps } from "../src/api/types/api-deps";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any) =>
    h.calls.push({ level, msg, fields });
  const fake = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    log: () => {},
    pino: { isLevelEnabled: () => false },
  };
  return { getLogger: () => fake, logger: fake };
});

const requests = () => h.calls.filter((c) => c.fields?.event === "http.request");

// The direct-write handlers this server is mostly made of: they write to the
// Node response themselves and hand Hono a 597 sentinel.
const deps = {
  localNoAuth: true,
  apiKey: "tb_0123456789abcdef0123456789abcdef",
  logMenubarRequests: true,
  handleConversationsCount: (_url: URL, res: any) => {
    const body = JSON.stringify({ count: 42 });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  },
  handleListConversations: (_url: URL, res: any) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "nope" }));
  },
} as unknown as ApiDeps;

let baseUrl: string;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  const app = createHonoApp(deps);
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  h.calls.length = 0;
});

describe("http.request log line", () => {
  it("logs the status the client got, not the 597 sentinel", async () => {
    // 96% of the lines in the 261MB prod log read `→ 597`, because a
    // direct-write route's Hono status is the internal sentinel. The status
    // the client actually received is on the Node response.
    const res = await fetch(`${baseUrl}/api/conversations/count`);
    expect(res.status).toBe(200);

    const [line] = requests();
    expect(line.fields.status).toBe(200);
    expect(line.msg).toContain("→ 200");
  });

  it("keeps reporting a real error status from a direct-write handler", async () => {
    await fetch(`${baseUrl}/api/conversations`);
    expect(requests()[0].fields.status).toBe(404);
  });

  it("records how many bytes the response actually carried", async () => {
    await fetch(`${baseUrl}/api/conversations/count`);
    expect(requests()[0].fields.bytes).toBe(JSON.stringify({ count: 42 }).length);
  });

  it("records the pagination parameters a request used", async () => {
    await fetch(`${baseUrl}/api/conversations/count?limit=50&offset=100`);
    expect(requests()[0].fields.qs).toBe("limit=50&offset=100");
  });

  // NONCE-DESIGN §10. The WS ticket is a credential and it can only travel in a
  // URL, so the request log is the one place it can leak on a healthy server.
  it("reduces an ALL-DIGIT ticket to _ in the http.request line", async () => {
    await fetch(`${baseUrl}/api/conversations/count?ticket=84719203847192`);
    expect(requests()[0].fields.qs).toBe("ticket=_");
  });

  it("omits qs and bytes when there is nothing to report", async () => {
    await fetch(`${baseUrl}/healthz`);
    const [line] = requests();
    expect(line.fields).not.toHaveProperty("qs");
    // /healthz is a Hono-piped response, serialized after this middleware
    // returns — its size is not knowable here, so no field rather than a 0.
    expect(line.fields).not.toHaveProperty("bytes");
  });
});

describe("summarizeQuery", () => {
  it("keeps numeric values — the pagination the log needs to show", () => {
    expect(summarizeQuery({ limit: "50", before_index: "1200" })).toBe(
      "before_index=1200&limit=50",
    );
    expect(summarizeQuery({ offset: "-1" })).toBe("offset=-1");
  });

  it("keeps the key but drops any value that is not a plain number", () => {
    // These carry file paths, conversation ids and search terms.
    expect(summarizeQuery({ path: "/Users/someone/secret-project" })).toBe("path=_");
    expect(summarizeQuery({ q: "my private search" })).toBe("q=_");
    expect(summarizeQuery({ id: "9f3c-abc", limit: "20" })).toBe("id=_&limit=20");
    expect(summarizeQuery({ limit: "50; DROP" })).toBe("limit=_");
  });

  // The gap NONCE-DESIGN §10 names: the numeric rule let an all-digit secret
  // through verbatim. A base64url ticket passes against the ORIGINAL code, so a
  // test using one could never have failed and would prove nothing.
  it("reduces a sensitive key regardless of the shape of its value", () => {
    expect(summarizeQuery({ ticket: "84719203847192" })).toBe("ticket=_");
    expect(summarizeQuery({ ticket: "Xk9_2bQz-aR4" })).toBe("ticket=_");
    expect(summarizeQuery({ key: "12345678901234567890" })).toBe("key=_");
    expect(summarizeQuery({ token: "42" })).toBe("token=_");
    // Case is not a way past it.
    expect(summarizeQuery({ Ticket: "84719203847192" })).toBe("Ticket=_");
  });

  // The control for the test above: the fix is a sensitive-KEY rule, not
  // blanket numeric redaction, which would cost the diagnostics this field
  // exists for.
  it("still logs a non-sensitive numeric parameter", () => {
    expect(summarizeQuery({ limit: "50" })).toBe("limit=50");
    expect(summarizeQuery({ limit: "50", ticket: "84719203847192" })).toBe("limit=50&ticket=_");
  });

  it("returns undefined for a bare path so the field stays absent", () => {
    expect(summarizeQuery({})).toBeUndefined();
  });
});
