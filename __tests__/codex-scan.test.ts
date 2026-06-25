import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationScanner } from "@threadbase-sh/scanner";

// Fixture is a real Codex rollout JSONL; id comes from the session_meta payload.
const CODEX_SESSION_ID = "019edbc1-13a7-7fa1-80b4-7eafc270f03e";
const FIXTURE_PATH = join(__dirname, "fixtures", "codex-rollout.jsonl");

// ponytail: profiles:[] skips the full Threadbase scan so tests finish in <2s
const CODEX_ONLY_SCAN = {
  profiles: [] as [],
  providers: ["codex-cli"] as ["codex-cli"],
};

function makeCodexRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "codex-scan-test-"));
  const dateDir = join(root, "2026", "06", "18");
  mkdirSync(dateDir, { recursive: true });
  copyFileSync(
    FIXTURE_PATH,
    join(dateDir, `rollout-2026-06-18T20-22-04-${CODEX_SESSION_ID}.jsonl`),
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("codex scan plumbing", () => {
  it("discovers codex sessions with provider=codex-cli when codexRoots is set", async () => {
    const { root, cleanup } = makeCodexRoot();
    const dbPath = join(root, "scanner.db");
    try {
      const scanner = new ConversationScanner({ dbPath });
      await scanner.scan({ ...CODEX_ONLY_SCAN, codexRoots: [root] });
      const codexItems = [...scanner.getMetadataCache().values()].filter(
        (m) => m.provider === "codex-cli",
      );
      expect(codexItems.length).toBeGreaterThan(0);
      expect(codexItems[0].id).toContain(CODEX_SESSION_ID);
    } finally {
      cleanup();
    }
  });

  it("returns zero codex sessions when codexRoots is empty", async () => {
    const { root, cleanup } = makeCodexRoot();
    const dbPath = join(root, "scanner.db");
    try {
      const scanner = new ConversationScanner({ dbPath });
      await scanner.scan({ ...CODEX_ONLY_SCAN, codexRoots: [] });
      const codexItems = [...scanner.getMetadataCache().values()].filter(
        (m) => m.provider === "codex-cli",
      );
      expect(codexItems.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("codex items from the fixture have provider=codex-cli", async () => {
    const { root, cleanup } = makeCodexRoot();
    const dbPath = join(root, "scanner.db");
    try {
      const scanner = new ConversationScanner({ dbPath });
      await scanner.scan({ ...CODEX_ONLY_SCAN, codexRoots: [root] });
      const codexItems = [...scanner.getMetadataCache().values()].filter((m) =>
        m.id?.includes(CODEX_SESSION_ID),
      );
      expect(codexItems.length).toBeGreaterThan(0);
      expect(codexItems[0].provider).toBe("codex-cli");
    } finally {
      cleanup();
    }
  });
});
