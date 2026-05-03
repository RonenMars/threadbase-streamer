import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConversationCache } from "../../src/conversation-cache";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
});
