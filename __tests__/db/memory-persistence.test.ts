import { describe, expect, it } from "vitest";
import { MemorySessionPersistence } from "../../src/db/memory-persistence";
import type { ManagedSession } from "../../src/types";

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "ses_abc123",
    conversationId: "conv_xyz",
    projectPath: "/tmp/project",
    projectName: "project",
    branch: "main",
    status: "running",
    startedAt: new Date("2026-04-18T10:00:00Z"),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    ...overrides,
  };
}

describe("MemorySessionPersistence", () => {
  it("implements all interface methods as no-ops", async () => {
    const persistence = new MemorySessionPersistence();
    const session = makeSession();

    await persistence.save(session);
    await persistence.update("ses_abc123", { status: "completed" });
    await persistence.remove("ses_abc123");

    const loaded = await persistence.loadAll();
    expect(loaded).toEqual([]);
  });
});
