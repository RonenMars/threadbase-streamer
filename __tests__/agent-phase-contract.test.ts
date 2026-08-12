// Contract tests for the agent-phase field: the wire shape and the pty-host relay.
//
// These exist because every failure mode this feature has is SILENT. A dropped
// null latches the indicator on a finished turn; a missing pty-host relay makes
// the feature no-op when the host flag is on. Neither shows up in a typecheck,
// and neither throws.

import { describe, expect, it, vi } from "vitest";
import {
  encodeMessage,
  type HostEvent,
  type HostRequest,
  PTY_HOST_PROTOCOL_VERSION,
} from "../src/pty-host/protocol";
import { RemoteSessionRunner } from "../src/pty-host/remote-session-runner";
import { SessionStore } from "../src/session-store";
import type { ManagedSession, PTYManagerOptions } from "../src/types";

const STARTED = new Date("2026-08-12T10:00:00Z");

function mkSession(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    provider: "claude-code",
    projectPath: "/repo",
    projectName: "repo",
    branch: "main",
    status: "running",
    startedAt: STARTED,
    completedAt: null,
    lastOutput: "",
    promptCount: 0,
    inputHistory: [],
    ...over,
  } as ManagedSession;
}

/** Minimal transport, mirroring the harness in pty-host-protocol.test.ts. */
function mkHost() {
  let onLine: (line: string) => void = () => {};
  const transport = {
    send(line: string) {
      const req = JSON.parse(line) as HostRequest;
      queueMicrotask(() => {
        const result =
          req.type === "status" ? { protocolVersion: PTY_HOST_PROTOCOL_VERSION, sessions: [] } : {};
        onLine(encodeMessage({ id: req.id, ok: true, result }));
      });
    },
    onLine(handler: (line: string) => void) {
      onLine = handler;
    },
    onClose(_handler: () => void) {},
    close: vi.fn(),
  };
  return { transport, emit: (e: HostEvent) => onLine(encodeMessage(e)) };
}

describe("agent phase — wire contract", () => {
  // The load-bearing one. managedToResponse guards ~19 optional fields with
  // `...(x != null && { x })`, and `!=` catches null as well as undefined. If
  // subStatus is ever moved into that block, an explicit "no phase" silently
  // becomes an absent key — and because clients merge session frames, an absent
  // key keeps its previous value. That is how tb-mobile PR #647's indicator
  // latched onto finished turns.
  it("serialises an explicit null rather than omitting the key", () => {
    const store = new SessionStore();
    store.addManaged(mkSession({ subStatus: null }));

    const resp = store.get("sess-1", new Set());

    expect(resp).not.toBeNull();
    expect("subStatus" in resp!).toBe(true);
    expect(resp!.subStatus).toBeNull();
    // The distinction a merge cannot express: absent !== null.
    expect(JSON.stringify(resp)).toContain('"subStatus":null');
  });

  it("serialises a set phase", () => {
    const store = new SessionStore();
    store.addManaged(mkSession({ subStatus: "working" }));
    expect(store.get("sess-1", new Set())!.subStatus).toBe("working");
  });

  it("emits null for a session that predates the field", () => {
    const store = new SessionStore();
    const s = mkSession();
    delete (s as Partial<ManagedSession>).subStatus;
    store.addManaged(s);

    const resp = store.get("sess-1", new Set());
    expect("subStatus" in resp!).toBe(true);
    expect(resp!.subStatus).toBeNull();
  });
});

describe("agent phase — pty-host relay", () => {
  // protocol.ts's header: "the detectors that fire them run in the host, so
  // every one of those callbacks needs an event here or the feature silently
  // stops working when the flag is on." Declaring the event in the union type
  // is NOT the same as wiring it — the type alone typechecks and does nothing.
  it("delivers a phase-change event to onPhaseChange", async () => {
    const onPhaseChange = vi.fn();
    const host = mkHost();
    await RemoteSessionRunner.connect(host.transport, { onPhaseChange } as PTYManagerOptions);

    host.emit({ type: "event", event: "phase-change", sessionId: "sess-1", phase: "working" });

    expect(onPhaseChange).toHaveBeenCalledWith("sess-1", "working");
  });

  // JSON.stringify drops undefined but preserves null — the property the whole
  // clearing contract rests on. Asserted through the real encoder rather than
  // assumed, because it is why `null` was chosen over omission.
  it("relays an explicit null across the boundary without dropping it", async () => {
    const onPhaseChange = vi.fn();
    const host = mkHost();
    await RemoteSessionRunner.connect(host.transport, { onPhaseChange } as PTYManagerOptions);

    host.emit({ type: "event", event: "phase-change", sessionId: "sess-1", phase: null });

    expect(onPhaseChange).toHaveBeenCalledWith("sess-1", null);
  });

  it("does not throw when the callback is omitted (additive)", async () => {
    const host = mkHost();
    await RemoteSessionRunner.connect(host.transport, {} as PTYManagerOptions);

    expect(() =>
      host.emit({ type: "event", event: "phase-change", sessionId: "sess-1", phase: "working" }),
    ).not.toThrow();
  });
});
