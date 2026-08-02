import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store";
import { confidenceForSource, type ManagedSession, type StatusSource } from "../src/types";

/**
 * Status source and confidence (C3).
 * See docs/architecture/2026-07-24-session-state-confidence.md.
 *
 * The runners already computed a `reason` at every transition and threw it away
 * in a log line, so a `waiting_input` reached because a 10-second timer expired
 * with NO prompt marker was byte-identical on the wire to one reached by
 * observing a marker. These tests pin the distinction.
 */

const UUID = "3f2a1c88-9b7e-4d21-8a55-1c0e7b9d4f60";

function mkSession(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: UUID,
    projectPath: "/tmp/project",
    projectName: "project",
    branch: "main",
    status: "waiting_input",
    startedAt: new Date("2026-07-24T10:00:00Z"),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    ...over,
  };
}

describe("confidenceForSource", () => {
  // The whole point: exactly the timer-driven paths are inferences.
  it.each<[StatusSource]>([
    ["timeout-fallback"],
    ["quiet-fallback"],
  ])("treats %s as inferred", (source) => {
    expect(confidenceForSource(source)).toBe("inferred");
  });

  it.each<[StatusSource]>([
    ["prompt-marker"],
    ["screen-marker"],
    ["process-exit"],
    ["user-input"],
    ["spawn"],
    ["shutdown"],
  ])("treats %s as observed", (source) => {
    expect(confidenceForSource(source)).toBe("observed");
  });
});

describe("SessionResponse carries source and confidence", () => {
  const noPty = new Set<string>();

  it("reports an observed marker transition as observed", () => {
    const store = new SessionStore();
    store.addManaged(mkSession({ statusSource: "prompt-marker" }));

    const resp = store.get(UUID, noPty);
    expect(resp?.statusSource).toBe("prompt-marker");
    expect(resp?.statusConfidence).toBe("observed");
  });

  // A guess must never reach a client wearing the same clothes as an
  // observation. This is the case the whole task exists for.
  it("reports a timeout fallback as inferred, with the same status value", () => {
    const store = new SessionStore();
    store.addManaged(mkSession({ statusSource: "timeout-fallback" }));

    const resp = store.get(UUID, noPty);
    expect(resp?.status).toBe("waiting_input"); // status itself is unchanged
    expect(resp?.statusConfidence).toBe("inferred");
  });

  it("omits the fields entirely when no source was recorded", () => {
    const store = new SessionStore();
    store.addManaged(mkSession());

    const resp = store.get(UUID, noPty);
    // Additive contract: absent, not defaulted to a confident value.
    expect(resp?.statusSource).toBeUndefined();
    expect(resp?.statusConfidence).toBeUndefined();
  });

  it("serializes statusUpdatedAt as an ISO string", () => {
    const store = new SessionStore();
    const at = new Date("2026-07-24T11:22:33.000Z");
    store.addManaged(mkSession({ statusSource: "prompt-marker", statusUpdatedAt: at }));

    expect(store.get(UUID, noPty)?.statusUpdatedAt).toBe(at.toISOString());
  });

  it("never reports a confidence that disagrees with its source", () => {
    const store = new SessionStore();
    for (const source of [
      "prompt-marker",
      "timeout-fallback",
      "quiet-fallback",
    ] as StatusSource[]) {
      store.addManaged(mkSession({ id: `${UUID}-${source}`, statusSource: source }));
      const resp = store.get(`${UUID}-${source}`, noPty);
      expect(resp?.statusConfidence).toBe(confidenceForSource(source));
    }
  });
});

/**
 * Guard against a future transition that sets `status` without saying why.
 * Such a transition would silently inherit whatever source was set last —
 * potentially reporting a stale `observed` for a state nothing observed.
 */
describe("every status transition declares a source", () => {
  const SRC = join(__dirname, "..", "src");

  it.each([
    "pty-manager.ts",
    "codex-pty-runner.ts",
  ])("%s sets statusSource wherever it assigns status", (file) => {
    const lines = readFileSync(join(SRC, file), "utf8").split("\n");

    const assignments: number[] = [];
    lines.forEach((line, i) => {
      // `session.status = "..."` — an actual runtime transition, not a type
      // annotation or an object literal key.
      if (/^\s*session\.status\s*=\s*"/.test(line)) assignments.push(i);
    });

    expect(assignments.length).toBeGreaterThan(0);

    for (const i of assignments) {
      // The source assignment sits within a few lines of the status change.
      const window = lines.slice(Math.max(0, i - 2), i + 5).join("\n");
      expect(window, `no statusSource near line ${i + 1} of ${file}`).toMatch(/statusSource/);
    }
  });

  it.each([
    "pty-manager.ts",
    "codex-pty-runner.ts",
  ])("%s reports the fields through toPublicSession", (file) => {
    const src = readFileSync(join(SRC, file), "utf8");
    expect(src).toContain("statusSource: s.statusSource");
    expect(src).toContain("statusUpdatedAt: s.statusUpdatedAt");
  });
});
