import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  cursorAgentTranscriptsDir,
  cursorProjectSlug,
  listCursorTranscriptWatchDirs,
} from "../src/cursor-transcript-watch";

describe("listCursorTranscriptWatchDirs", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tb-cursor-watch-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns only slug/agent-transcripts folders that exist", () => {
    const withTranscripts = join(root, "worktree-a", "agent-transcripts");
    mkdirSync(withTranscripts, { recursive: true });
    mkdirSync(join(root, "worktree-b", "canvases"), { recursive: true });
    mkdirSync(join(root, "worktree-c", "node_modules", "foo"), { recursive: true });
    writeFileSync(join(root, "not-a-dir"), "skip");

    expect(listCursorTranscriptWatchDirs([root])).toEqual([withTranscripts]);
  });

  it("skips missing roots and collects from each given root", () => {
    const other = mkdtempSync(join(tmpdir(), "tb-cursor-watch-other-"));
    const a = join(root, "one", "agent-transcripts");
    const b = join(other, "two", "agent-transcripts");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    try {
      expect(listCursorTranscriptWatchDirs([root, join(root, "missing"), other])).toEqual([a, b]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("cursorAgentTranscriptsDir", () => {
  it("joins root + slug + agent-transcripts", () => {
    expect(cursorAgentTranscriptsDir("/tmp/cursor-projects", "/Users/me/app")).toBe(
      join("/tmp/cursor-projects", cursorProjectSlug("/Users/me/app"), "agent-transcripts"),
    );
  });
});
