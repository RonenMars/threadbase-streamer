import { StreamerHttpError } from "../cli/mcp/client";
import { tailTerminalTools } from "../cli/mcp/tail-terminal";

describe("tail_terminal handler", () => {
  const tool = tailTerminalTools[0];
  const run = (get: (path: string) => unknown) =>
    tool.handler({ sessionId: "s1", lines: 50 }, { get: async (p: string) => get(p) } as never);

  it("reports an externally owned session as not live without reading output", async () => {
    const paths: string[] = [];
    const res = await run((p) => {
      paths.push(p);
      return { status: "running", ownership: "external" };
    });
    expect(JSON.stringify(res)).toMatch(/not live/);
    expect(paths).toEqual(["/api/sessions/s1"]);
  });

  it("turns a 404 into a one-line not-found error", async () => {
    await expect(
      run(() => {
        throw new StreamerHttpError(404, "x");
      }),
    ).rejects.toThrow("Session not found.");
  });

  it("asks the output route for exactly the requested lines and returns them", async () => {
    const paths: string[] = [];
    const res = await tool.handler({ sessionId: "s1", lines: 7 }, {
      get: async (p: string) => {
        paths.push(p);
        return p.includes("/output") ? { lines: ["a", "b"] } : { status: "running" };
      },
    } as never);
    expect(paths).toEqual(["/api/sessions/s1", "/api/sessions/s1/output?lines=7"]);
    expect(res.content).toEqual([{ type: "text", text: "a\nb" }]);
  });

  it("says the terminal has produced no output yet when the screen is empty", async () => {
    const res = await run((p) => (p.includes("/output") ? { lines: [] } : { status: "running" }));
    expect(JSON.stringify(res)).toMatch(/no output yet/);
  });
});
