import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../../src/conversation-cache";

let tmpDir: string;
let cache: ConversationCache;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tb-test-"));
  cache = ConversationCache.open(join(tmpDir, "cache.db"));
});

afterEach(() => {
  cache.close();
  rmSync(tmpDir, { recursive: true });
});

describe("session_names", () => {
  it("returns null for unknown session", () => {
    expect(cache.getSessionName("unknown")).toBeNull();
  });

  it("upserts and retrieves a name", () => {
    cache.upsertSessionName("sess_1", "fix-auth-bug");
    expect(cache.getSessionName("sess_1")).toBe("fix-auth-bug");
  });

  it("updates existing name when newer", () => {
    cache.upsertSessionName("sess_1", "old-name");
    cache.upsertSessionName("sess_1", "new-name");
    expect(cache.getSessionName("sess_1")).toBe("new-name");
  });

  it("listSessionNames returns all names", () => {
    cache.upsertSessionName("sess_1", "name-one");
    cache.upsertSessionName("sess_2", "name-two");
    const names = cache.listSessionNames();
    expect(names).toEqual({ sess_1: "name-one", sess_2: "name-two" });
  });

  it("does not overwrite with a stale timestamp", () => {
    // Write name with a high timestamp directly via the prepared statement
    (cache as any).stmts.upsertSessionName.run("sess_1", "current-name", 9999999999999);
    // Attempt to overwrite with a lower timestamp — should be rejected by WHERE guard
    (cache as any).stmts.upsertSessionName.run("sess_1", "stale-name", 1);
    expect(cache.getSessionName("sess_1")).toBe("current-name");
  });
});
