import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { Hono } from "hono";
import type { ServerResponse } from "http";
import { join } from "path";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { MAX_OUTPUT_LINES } from "../src/api/output-lines";
import { PTYManager } from "../src/pty-manager";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const ee = new EventEmitter();
    return {
      pid: 1,
      onData: (cb: (d: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }),
}));

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    writeHead: (s: number) => {
      out.status = s;
    },
    end: (b: string) => {
      out.body = JSON.parse(b);
    },
  } as unknown as ServerResponse;
  return { res, out };
}

function handlersWith(ptyManager: unknown) {
  return new SessionHandlers({ ptyManager } as unknown as SessionHandlersDeps);
}

async function get(h: SessionHandlers, id: string, lines?: string) {
  const { res, out } = fakeRes();
  await h.handleGetOutput(id, res, lines);
  return out;
}

describe("GET /api/sessions/:id/output", () => {
  const spy = {
    getOutput: vi.fn(() => "RAW"),
    getOutputLines: vi.fn(async () => ["row 1", "row 2"]),
  };
  const h = handlersWith(spy);
  beforeEach(() => {
    spy.getOutput.mockClear();
    spy.getOutputLines.mockClear();
  });

  it("without lines answers today's { output } shape from the raw buffer", async () => {
    expect(await get(h, "s1")).toEqual({ status: 200, body: { output: "RAW" } });
    expect(spy.getOutputLines).not.toHaveBeenCalled();
  });

  it("with lines answers { lines } from the rendered screen, not the raw buffer", async () => {
    expect(await get(h, "s1", "7")).toEqual({ status: 200, body: { lines: ["row 1", "row 2"] } });
    expect(spy.getOutputLines).toHaveBeenCalledWith("s1", 7);
    expect(spy.getOutput).not.toHaveBeenCalled();
  });

  it("accepts exactly 1 and the max", async () => {
    expect((await get(h, "s1", "1")).status).toBe(200);
    expect((await get(h, "s1", String(MAX_OUTPUT_LINES))).status).toBe(200);
  });

  it.each(["0", "1.5", "abc", "", String(MAX_OUTPUT_LINES + 1), "-3", "1e2", "%205", "0x10", " 5"])(
    "rejects lines=%j with 400",
    async (bad) => {
      expect((await get(h, "s1", bad)).status).toBe(400);
      expect(spy.getOutputLines).not.toHaveBeenCalled();
    },
  );

  it("uses the first value of a repeated lines query (Hono's c.req.query)", async () => {
    const app = new Hono().get("/o", async (c) => {
      const r = await get(h, "s1", c.req.query("lines"));
      return c.json(r);
    });
    const body = (await (await app.request("/o?lines=5&lines=abc")).json()) as { status: number };
    expect(body.status).toBe(200);
    expect(spy.getOutputLines).toHaveBeenCalledWith("s1", 5);
  });

  it("keeps an unknown id as an empty 200 in both shapes", async () => {
    const unknown = handlersWith({
      getOutput: () => {
        throw new Error("Session not found");
      },
      getOutputLines: async () => {
        throw new Error("Session not found");
      },
    });
    expect(await get(unknown, "nope")).toEqual({ status: 200, body: { output: "" } });
    expect(await get(unknown, "nope", "5")).toEqual({ status: 200, body: { lines: [] } });
  });
});

describe("rendered lines of a real Claude capture", () => {
  it("are several readable lines with no escape bytes, unlike the raw buffer", async () => {
    const cap: { chunks: [number, string][] } = JSON.parse(
      readFileSync(join(__dirname, "fixtures/turn-signals/claude-2.1.280-turn.json"), "utf8"),
    );
    const mgr = new PTYManager({});
    const session = await mgr.startFresh({ projectPath: "/tmp", projectName: "p" });
    const proc = (
      mgr as unknown as { sessions: Map<string, { process: { _emit: Function } }> }
    ).sessions.get(session.id)?.process;
    for (const [, d] of cap.chunks) proc?.["_emit"]("data", d);
    const h = handlersWith(mgr);
    const { res, out } = fakeRes();
    await h.handleGetOutput(session.id, res, "40");
    const lines = (out.body as { lines: string[] }).lines;
    expect(lines.length).toBeGreaterThan(1);
    expect(mgr.getOutput(session.id)).toContain("\x1b");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(lines.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });
});
