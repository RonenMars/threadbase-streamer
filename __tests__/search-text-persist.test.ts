import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationScanner } from "@threadbase-sh/scanner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ScannerManager } from "../src/scanner-manager";

describe("search text survives a restart (#1311)", () => {
  let dir: string;
  let cache: ConversationCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "search-text-"));
    cache = ConversationCache.open(join(dir, "cache.db"), 3);
  });
  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips bodies and drops ids that are gone", () => {
    cache.replaceSearchTexts(
      new Map([
        ["a", "alpha"],
        ["b", "beta"],
      ]),
    );
    cache.replaceSearchTexts(new Map([["a", "alpha2"]]));
    expect([...cache.getSearchTexts()]).toEqual([["a", "alpha2"]]);
  });

  it("a scanner built after persisting is seeded", () => {
    const m = new ScannerManager({ cache: () => cache } as never);
    cache.replaceSearchTexts(new Map([["x", "zebrafish"]]));
    const seeded = m.newScanner({ persistent: false });
    expect(seeded.exportSearchContents().get("x")).toBe("zebrafish");
    const empty = new ConversationScanner({ persistent: false });
    expect(empty.exportSearchContents().size).toBe(0);
  });

  it("a refreshed file's new text is stored, not just held in memory", async () => {
    const id = "019a0000-0000-7000-8000-000000000001";
    const file = join(dir, `rollout-2026-09-05T12-00-00-${id}.jsonl`);
    const line = (text: string, sec: number) =>
      `${JSON.stringify({
        timestamp: `2026-09-05T12:00:0${sec}.000Z`,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      })}\n`;
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { id, cwd: dir } })}\n${line("first", 1)}`,
    );
    const m = new ScannerManager({
      scanProfiles: [],
      codexRoots: [dir],
      cursorRoots: [],
      directoryDebounceMs: 0,
      persistenceDisabled: true,
      cache: () => cache,
      cacheMonitor: () => null,
      projectsRepo: () => null,
      conversationsRepo: () => null,
      cacheMetadataRepo: () => null,
      trackCacheWrite: () => {},
    } as never);
    const scanner = new ConversationScanner({ persistent: false });
    m.track(scanner);
    await scanner.scan({ profiles: [], codexRoots: [dir] } as never);
    appendFileSync(file, line("quokkaword", 2));
    await m.refreshFileAfterWrite(scanner, file);
    expect([...cache.getSearchTexts().values()].join(" ")).toContain("quokkaword");
    await m.close();
  });
});
