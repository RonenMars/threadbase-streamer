import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { overlayClaudeRegistry } from "../src/process-discovery";
import { SessionStore } from "../src/session-store";
import type { DiscoveredProcess } from "../src/types";

// Wrap readFile in a spy that delegates to the real one, so tests can see which
// paths the overlay opened and fail a single read.
vi.mock("fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs/promises")>();
  return { ...real, readFile: vi.fn(real.readFile) };
});
const readFileSpy = vi.mocked(readFile);
const realReadFile = readFileSpy.getMockImplementation() as typeof readFile;

const FIXTURE = join(__dirname, "fixtures/providers/claude-code/2.1.310/sessions/12345.json");
const FIXTURE_ID = "00000000-0000-4000-8000-000000000001";

function proc(overrides: Partial<DiscoveredProcess> = {}): DiscoveredProcess {
  return {
    pid: 12345,
    provider: "claude-code",
    projectPath: "/argv/project",
    projectName: "project",
    branch: "",
    conversationId: null,
    startedAt: new Date(0),
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...JSON.parse(readFileSync(FIXTURE, "utf8")), ...overrides });
}

describe("overlayClaudeRegistry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-sessions-"));
    writeFileSync(join(dir, "12345.json"), readFileSync(FIXTURE));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    readFileSpy.mockClear().mockImplementation(realReadFile);
  });

  it("fills a null conversationId from the matching pid's record", async () => {
    const [p] = await overlayClaudeRegistry([proc()], dir);
    expect(p.conversationId).toBe(FIXTURE_ID);
  });

  it("keeps an argv conversationId over the registry's", async () => {
    const [p] = await overlayClaudeRegistry([proc({ conversationId: "from-argv" })], dir);
    expect(p.conversationId).toBe("from-argv");
  });

  it("leaves a pid with no record untouched and adds nothing for registry-only pids", async () => {
    const out = await overlayClaudeRegistry([proc({ pid: 999 })], dir);
    expect(out).toEqual([proc({ pid: 999 })]);
  });

  it("does not touch a non-Claude process at the same pid", async () => {
    const codex = proc({ provider: "codex-cli" });
    const [p] = await overlayClaudeRegistry([codex], dir);
    expect(p).toEqual(codex);
  });

  it("fills an empty projectPath from cwd and replaces startedAt", async () => {
    const [p] = await overlayClaudeRegistry([proc({ projectPath: "", projectName: "" })], dir);
    expect(p.projectPath).toBe("/home/example/project");
    expect(p.projectName).toBe("project");
    expect(p.startedAt.getTime()).toBe(1792838815236);
  });

  it("keeps a non-empty projectPath from the sweep", async () => {
    const [p] = await overlayClaudeRegistry([proc()], dir);
    expect(p.projectPath).toBe("/argv/project");
  });

  it("never reads the .key siblings", async () => {
    writeFileSync(join(dir, "12345.abcdef.key"), '{"peerToken":"secret"}');
    await overlayClaudeRegistry([proc()], dir);
    const read = readFileSpy.mock.calls.map((c) => String(c[0]));
    expect(read.length).toBeGreaterThan(0);
    expect(read.some((f) => f.endsWith(".key"))).toBe(false);
  });

  it("skips agent entrypoints", async () => {
    writeFileSync(join(dir, "12345.json"), record({ entrypoint: "sdk-cli" }));
    const [p] = await overlayClaudeRegistry([proc()], dir);
    expect(p.conversationId).toBeNull();
  });

  it("skips a malformed file while applying the others", async () => {
    writeFileSync(join(dir, "777.json"), "{not json");
    writeFileSync(join(dir, "778.json"), JSON.stringify({ pid: 778 }));
    const out = await overlayClaudeRegistry([proc(), proc({ pid: 777 }), proc({ pid: 778 })], dir);
    expect(out.map((p) => p.conversationId)).toEqual([FIXTURE_ID, null, null]);
  });

  it("skips a file deleted between readdir and read", async () => {
    writeFileSync(join(dir, "777.json"), record({ pid: 777, sessionId: "gone" }));
    readFileSpy.mockImplementation(((p: string, ...rest: unknown[]) =>
      String(p).endsWith("777.json")
        ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        : (realReadFile as any)(p, ...rest)) as typeof readFile);
    const out = await overlayClaudeRegistry([proc(), proc({ pid: 777 })], dir);
    expect(out.map((p) => p.conversationId)).toEqual([FIXTURE_ID, null]);
  });

  it("returns the input unchanged when the directory is missing", async () => {
    const input = [proc()];
    const out = await overlayClaudeRegistry(input, join(dir, "nope"));
    expect(out).toBe(input);
  });

  it("lists a plain terminal session with its pid, which is what /terminate resolves", async () => {
    const store = new SessionStore();
    store.setDiscovered([proc({ conversationId: null })]);
    expect(store.get(FIXTURE_ID, new Set())).toBeNull();

    store.setDiscovered(await overlayClaudeRegistry([proc({ conversationId: null })], dir));
    expect(store.get(FIXTURE_ID, new Set())?.pid).toBe(12345);
  });
});
