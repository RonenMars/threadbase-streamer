import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { connect, type Socket } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";
import { createMiscRoutes } from "../src/api/routes/misc.routes";
import { listenRelayIngress, RELAY_CLIENT_HEADER, rateLimitKey } from "../src/relay/ingress";
import { StreamerServer } from "../src/server";

/**
 * Node builds `req.headers` with `Object.prototype`, so a bracket read of a
 * header that is absent on the wire returns whatever a polluted prototype
 * holds. Every raw read must take only what Node parsed from the request.
 *
 * Each test pollutes the prototype for ONE header name, hands the code a
 * request that does not carry that header, and checks the polluted value never
 * reaches the logic. `afterEach` removes every property so no other test sees it.
 */

const polluted: string[] = [];
function pollute(name: string, value: string): void {
  Object.defineProperty(Object.prototype, name, { value, configurable: true, writable: true });
  polluted.push(name);
}
afterEach(() => {
  for (const name of polluted.splice(0)) delete (Object.prototype as Record<string, unknown>)[name];
});

const fakeReq = (body = "{}", extra: object = {}) =>
  Object.assign(Readable.from([Buffer.from(body)]), {
    headers: {},
    ...extra,
  }) as unknown as IncomingMessage;

const fakeRes = () => {
  const res = {
    statusCode: 0,
    writeHead(status: number) {
      res.statusCode = status;
    },
    setHeader() {},
    end() {},
  };
  return res as typeof res & ServerResponse;
};

describe("header reads ignore a polluted Object.prototype", () => {
  it("search-target: a polluted content-type does not become the request's", async () => {
    pollute("content-type", "text/plain");
    const res = fakeRes();
    await new ConversationHandlers({} as never).handleSearchTarget("x", fakeReq(), res);
    // 415 means the polluted value was read; an empty `{}` body is a 422 for a missing `q`.
    expect(res.statusCode).toBe(422);
  });

  describe("on a server", () => {
    let server: StreamerServer;
    beforeEach(() => {
      server = new StreamerServer({
        port: 0,
        apiKey: "tb_test_key_for_header_reads",
        verbose: false,
      });
    });
    afterEach(async () => {
      await server.close();
    });

    it("pair exchange: a polluted content-type does not satisfy the JSON check", async () => {
      pollute("content-type", "application/json");
      const res = fakeRes();
      await (server as any).handlePairExchange(fakeReq(), res);
      expect(res.statusCode).toBe(415);
    });

    it("session list: a polluted x-client-id does not pick a socket to unicast to", () => {
      pollute("x-client-id", "victim");
      (server as any).clientIdToWs.set("victim", {});
      const unicast = vi.spyOn((server as any).wsHub, "unicast").mockImplementation(() => {});
      const broadcast = vi.spyOn((server as any).wsHub, "broadcast").mockImplementation(() => {});
      (server as any).broadcastOrUnicastSessionList(fakeReq());
      expect(unicast).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledOnce();
    });

    it("request router: a polluted host does not build the request URL", async () => {
      pollute("host", "not a host");
      const res = fakeRes();
      Object.assign(res, { write() {}, getHeader() {}, headersSent: false });
      // Throws `TypeError: Invalid URL` while the polluted host is read.
      await expect(
        (server as any).handleRequest(fakeReq("", { url: "/healthz", method: "GET" }), res),
      ).resolves.toBeUndefined();
    });
  });

  it("push register: a polluted accept-language is not stored as the token's locale", async () => {
    pollute("accept-language", "xx");
    const register = vi.fn();
    const app = createMiscRoutes({
      publicUrl: null,
      sessionStore: { list: () => [] },
      ptyAttachedIds: () => new Set(),
      rotateApiKey: () => ({ newKey: "x", persisted: false }),
      localNoAuth: true,
      pushRepo: () => ({ register }),
      liveActivityPushEnabled: () => false,
      expoPushEnabled: () => false,
      featureFlagsConfig: () => ({ registry: [], values: {}, sources: {} }),
    } as never);
    const incoming = fakeReq(JSON.stringify({ token: "t1", platform: "ios" }));
    const res = await app.request("/api/push/register", { method: "POST" }, { incoming });
    expect(res.status).toBe(200);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ locale: null }));
  });

  describe("relay rate-limit key", () => {
    let dir: string;
    let ingress: Awaited<ReturnType<typeof listenRelayIngress>>;
    let client: Socket;

    afterEach(() => {
      client?.destroy();
      ingress?.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("a polluted client tag does not choose the bucket", async () => {
      dir = mkdtempSync(join(tmpdir(), "tb-hdr-"));
      const path =
        process.platform === "win32" ? `\\\\.\\pipe\\tb-hdr-${process.pid}` : join(dir, "i.sock");
      const stand = new EventEmitter();
      const accepted = new Promise<Socket>((resolve) => stand.once("connection", resolve));
      ingress = await listenRelayIngress(stand as never, path);
      client = connect(path);
      const socket = await accepted;
      pollute(RELAY_CLIENT_HEADER, "victim");
      expect(rateLimitKey({ socket, headers: {} } as never)).toBe("relay:unknown");
    });
  });
});
