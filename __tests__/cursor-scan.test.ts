import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationScanner } from "@threadbase-sh/scanner";

const CURSOR_SESSION_ID = "sess-basic-0001";
const FIXTURE_PATH = join(__dirname, "fixtures", "cursor-transcript.jsonl");

const CURSOR_ONLY_SCAN = {
  profiles: [] as [],
  providers: ["cursor-cli"] as ["cursor-cli"],
};

function makeCursorRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "cursor-scan-test-"));
  const sessionDir = join(root, "Users-dev-widget", "agent-transcripts", CURSOR_SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  copyFileSync(FIXTURE_PATH, join(sessionDir, `${CURSOR_SESSION_ID}.jsonl`));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("cursor scan plumbing", () => {
  it("discovers cursor sessions with provider=cursor-cli when cursorRoots is set", async () => {
    const { root, cleanup } = makeCursorRoot();
    try {
      const scanner = new ConversationScanner({ persistent: false });
      await scanner.scan({ ...CURSOR_ONLY_SCAN, cursorRoots: [root] });
      const items = [...scanner.getMetadataCache().values()].filter(
        (m) => m.provider === "cursor-cli",
      );
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].sessionId).toBe(CURSOR_SESSION_ID);
    } finally {
      cleanup();
    }
  });

  it("returns zero cursor sessions when cursorRoots is empty", async () => {
    // The fixture must exist on disk but must NOT be handed to the scanner —
    // a scan that ignored cursorRoots would find it and fail the assertion.
    const { cleanup } = makeCursorRoot();
    try {
      const scanner = new ConversationScanner({ persistent: false });
      await scanner.scan({ ...CURSOR_ONLY_SCAN, cursorRoots: [] });
      const items = [...scanner.getMetadataCache().values()].filter(
        (m) => m.provider === "cursor-cli",
      );
      expect(items.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("cursor items from the fixture have provider=cursor-cli", async () => {
    const { root, cleanup } = makeCursorRoot();
    try {
      const scanner = new ConversationScanner({ persistent: false });
      await scanner.scan({ ...CURSOR_ONLY_SCAN, cursorRoots: [root] });
      const items = [...scanner.getMetadataCache().values()].filter((m) =>
        m.sessionId?.includes(CURSOR_SESSION_ID),
      );
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].provider).toBe("cursor-cli");
    } finally {
      cleanup();
    }
  });
});
