import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  conversationBusy,
  RESUME_BUSY_WINDOW_MS,
  resolveResumeBusyWindowMs,
} from "../src/services/sessions/conversationBusy";
import type { DiscoveredProcess } from "../src/types";

const CONV = "aaaaaaaa-0000-0000-0000-000000000001";
const PROJECT = "/tmp/some/project";

function proc(overrides: Partial<DiscoveredProcess> = {}): DiscoveredProcess {
  return {
    pid: 1234,
    projectPath: "/other/path",
    projectName: "other",
    branch: "",
    conversationId: null,
    startedAt: new Date(),
    ...overrides,
  };
}

describe("conversationBusy", () => {
  let dir: string;
  let jsonlPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-busy-probe-"));
    jsonlPath = join(dir, `${CONV}.jsonl`);
    writeFileSync(jsonlPath, `${JSON.stringify({ sessionId: CONV, cwd: PROJECT })}\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports busy via jsonl_mtime when the JSONL was written within the window", () => {
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      discovered: [],
    });
    expect(r.busy).toBe(true);
    expect(r.detectedBy).toEqual(["jsonl_mtime"]);
    // No matched process → owner unknown.
    expect(r.likelyOwner).toBe("unknown");
    expect(r.lastActivityMs).not.toBeNull();
    expect(r.lastActivityMs as number).toBeGreaterThanOrEqual(0);
  });

  it("is NOT busy when the JSONL mtime is older than the window", () => {
    const old = new Date(Date.now() - (RESUME_BUSY_WINDOW_MS + 60_000));
    utimesSync(jsonlPath, old, old);
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      discovered: [],
    });
    expect(r.busy).toBe(false);
    expect(r.detectedBy).toEqual([]);
    // lastActivityMs is still measured even when it doesn't count as busy.
    expect(r.lastActivityMs as number).toBeGreaterThan(RESUME_BUSY_WINDOW_MS);
  });

  it("is NOT busy when there is no JSONL and no matching process", () => {
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath: join(dir, "does-not-exist.jsonl"),
      discovered: [proc()],
    });
    expect(r.busy).toBe(false);
    expect(r.detectedBy).toEqual([]);
    expect(r.lastActivityMs).toBeNull();
  });

  it("reports busy via process_argv when a discovered process resumes this id", () => {
    const old = new Date(Date.now() - (RESUME_BUSY_WINDOW_MS + 60_000));
    utimesSync(jsonlPath, old, old); // ensure only the argv signal fires
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      discovered: [proc({ conversationId: CONV })],
      platform: "linux",
    });
    expect(r.busy).toBe(true);
    expect(r.detectedBy).toContain("process_argv");
    expect(r.likelyOwner).toBe("external");
  });

  it("reports busy via process_cwd on POSIX when a process runs in the project dir", () => {
    const old = new Date(Date.now() - (RESUME_BUSY_WINDOW_MS + 60_000));
    utimesSync(jsonlPath, old, old);
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      // A different conversation, but same project dir (launched without --resume).
      discovered: [proc({ projectPath: `${PROJECT}/`, conversationId: "other-conv" })],
      platform: "linux",
    });
    expect(r.busy).toBe(true);
    expect(r.detectedBy).toEqual(["process_cwd"]);
    expect(r.likelyOwner).toBe("external");
  });

  it("skips the process_cwd signal on win32 (cwd unavailable)", () => {
    const old = new Date(Date.now() - (RESUME_BUSY_WINDOW_MS + 60_000));
    utimesSync(jsonlPath, old, old);
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      discovered: [proc({ projectPath: PROJECT, conversationId: "other-conv" })],
      platform: "win32",
    });
    expect(r.detectedBy).not.toContain("process_cwd");
    expect(r.busy).toBe(false);
  });

  it("honors an explicit windowMs override", () => {
    const ageMs = RESUME_BUSY_WINDOW_MS + 60_000;
    const old = new Date(Date.now() - ageMs);
    utimesSync(jsonlPath, old, old);
    // Default window: too old → not busy.
    expect(
      conversationBusy({ conversationId: CONV, projectPath: PROJECT, jsonlPath, discovered: [] })
        .busy,
    ).toBe(false);
    // Wider override that includes this age → busy.
    expect(
      conversationBusy({
        conversationId: CONV,
        projectPath: PROJECT,
        jsonlPath,
        discovered: [],
        windowMs: ageMs + 60_000,
      }).busy,
    ).toBe(true);
  });
});

describe("conversationBusy — self-echo attribution", () => {
  let dir: string;
  let jsonlPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-busy-self-"));
    jsonlPath = join(dir, `${CONV}.jsonl`);
    writeFileSync(jsonlPath, `${JSON.stringify({ sessionId: CONV, cwd: PROJECT })}\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The hold → resume round trip: our own PTY wrote the file moments ago and was
  // then released, so hasSession no longer short-circuits. Without attribution
  // this 409s the most common resume in the product.
  it("does NOT report busy when the recent write predates our own PTY ending", () => {
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      discovered: [],
      selfPtyEndedAt: Date.now(),
    });
    expect(r.detectedBy).not.toContain("jsonl_mtime");
    expect(r.busy).toBe(false);
    // Still reports how long ago the file changed, just doesn't call it a collision.
    expect(r.lastActivityMs).not.toBeNull();
  });

  it("reports busy when the file was written AFTER our PTY ended (a real foreign write)", () => {
    // Our PTY ended well before the file's current mtime.
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      discovered: [],
      selfPtyEndedAt: Date.now() - 60_000,
    });
    expect(r.detectedBy).toContain("jsonl_mtime");
    expect(r.busy).toBe(true);
  });

  it("still reports busy on a process match even when the write is our own echo", () => {
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      discovered: [proc({ conversationId: CONV })],
      selfPtyEndedAt: Date.now(),
    });
    expect(r.detectedBy).toEqual(["process_argv"]);
    expect(r.busy).toBe(true);
    expect(r.likelyOwner).toBe("external");
  });

  it("tolerates a flush that lands just after the PTY was observed idle", () => {
    // File mtime is 'now'; our PTY was seen ending 2s ago — inside the skew.
    const r = conversationBusy({
      conversationId: CONV,
      projectPath: PROJECT,
      jsonlPath,
      discovered: [],
      selfPtyEndedAt: Date.now() - 2_000,
    });
    expect(r.busy).toBe(false);
  });
});

describe("resolveResumeBusyWindowMs", () => {
  it("defaults to RESUME_BUSY_WINDOW_MS when the env var is unset", () => {
    expect(resolveResumeBusyWindowMs({})).toBe(RESUME_BUSY_WINDOW_MS);
  });

  it("reads a valid override from the env", () => {
    expect(resolveResumeBusyWindowMs({ THREADBASE_RESUME_BUSY_WINDOW_MS: "5000" })).toBe(5000);
  });

  it("falls back to the default for an invalid override", () => {
    expect(resolveResumeBusyWindowMs({ THREADBASE_RESUME_BUSY_WINDOW_MS: "not-a-number" })).toBe(
      RESUME_BUSY_WINDOW_MS,
    );
  });
});
