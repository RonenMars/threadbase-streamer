import { extractResumeId } from "../src/process-discovery";
import { SessionStore } from "../src/session-store";
import type { DiscoveredProcess, ManagedSession } from "../src/types";

// P3: ownership / processLiveness are ADDITIVE. They must never become new
// `status` values — VALID_STATUSES rejects unknown values in ?status= and the
// store drops sessions outside the requested set, so a new status string would
// make these sessions vanish from already-shipped apps.
describe("session ownership fields", () => {
  const managed: ManagedSession = {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    projectPath: "/tmp/p",
    projectName: "p",
    branch: "main",
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    promptCount: 1,
    lastOutput: "",
  } as ManagedSession;

  const discovered: DiscoveredProcess = {
    pid: 4321,
    projectPath: "/tmp/p",
    projectName: "p",
    branch: "main",
    conversationId: "bbbbbbbb-0000-0000-0000-000000000002",
    startedAt: new Date(),
  };

  it("marks streamer-spawned sessions as managed and attaches no inferred activity", () => {
    const store = new SessionStore();
    store.addManaged(managed);
    const [resp] = store.list(new Set([managed.id]));
    expect(resp.ownership).toBe("managed");
    // We own the PTY, so `status` is authoritative — no JSONL guesswork.
    expect(resp.activity).toBeUndefined();
    expect(resp.processLiveness).toBeUndefined();
  });

  it("marks discovered processes external + alive while KEEPING status idle", () => {
    const store = new SessionStore();
    store.setDiscovered([discovered]);
    const [resp] = store.list(new Set());
    expect(resp.ownership).toBe("external");
    expect(resp.processLiveness).toBe("alive");
    // Critical: still 'idle'. Reporting 'running' would route mobile to the
    // destructive Overtake screen.
    expect(resp.status).toBe("idle");
    expect(resp.ptyAttached).toBe(false);
    expect(resp.pid).toBe(4321);
  });

  it("keeps status within the existing vocabulary so ?status= filtering is unaffected", () => {
    const store = new SessionStore();
    store.addManaged(managed);
    store.setDiscovered([discovered]);
    for (const s of store.list(new Set([managed.id]))) {
      expect(["running", "waiting_input", "idle"]).toContain(s.status);
    }
  });
});

// P4.c: the regex previously missed -r / --resume=, and captured a following
// flag as the id ('claude --resume --model opus' → '--model').
describe("extractResumeId", () => {
  it("reads the spaced long form", () => {
    expect(extractResumeId("claude --resume abc-123")).toBe("abc-123");
  });

  it("reads the = form", () => {
    expect(extractResumeId("claude --resume=abc-123")).toBe("abc-123");
  });

  it("reads the -r short flag", () => {
    expect(extractResumeId("claude -r abc-123")).toBe("abc-123");
  });

  it("does NOT capture a following flag as the conversation id", () => {
    expect(extractResumeId("claude --resume --model opus")).toBeNull();
    expect(extractResumeId("claude -r --model opus")).toBeNull();
  });

  it("returns null when there is no resume flag at all", () => {
    expect(extractResumeId("claude --dangerously-skip-permissions")).toBeNull();
  });
});
