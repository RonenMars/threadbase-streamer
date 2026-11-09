import pino from "pino";

// Under `tb-streamer mcp` stdout is the MCP protocol stream, so the logger
// must put every line on stderr, whatever `dest` the caller asked for.
// The switch is read at module load (hence the reload per test); the TTY check
// is read per call, so both stay stubbed until afterEach.
let restoreProcess = () => {};
async function loadLoggerWithArgv2(arg: string, isTTY: boolean) {
  const argv = process.argv;
  const tty = process.stdout.isTTY;
  process.argv = [...argv.slice(0, 2), arg];
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  restoreProcess = () => {
    process.argv = argv;
    Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
  };
  vi.resetModules();
  return await import("../src/logger");
}

function streamFd(logger: pino.Logger): number | undefined {
  const stream = logger[pino.symbols.streamSym] as { fd?: number } | undefined;
  return stream?.fd;
}

describe("logger under the mcp subcommand", () => {
  afterEach(() => {
    restoreProcess();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("writes pino to fd 2 and never to console, even for an explicit console dest at a TTY", async () => {
    const { getLogger } = await loadLoggerWithArgv2("mcp", true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = getLogger("t");
    expect(streamFd(logger.pino)).toBe(2);
    logger.info("hello", undefined, "console");
    logger.info("hello", undefined, "both");
    logger.info("hello");
    expect(log).not.toHaveBeenCalled();
  });

  it("is unchanged for every other subcommand: fd 1 pino, console at a TTY", async () => {
    const { getLogger } = await loadLoggerWithArgv2("serve", true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = getLogger("t");
    expect(streamFd(logger.pino)).not.toBe(2);
    logger.info("hello");
    expect(log).toHaveBeenCalledWith("hello");
  });
});
