/**
 * Conversation id -> JSONL path.
 *
 * `findJsonlPath` reconstructs `<projectsDir>/<dir>/<uuid>.jsonl`, which is
 * Claude Code's layout. A Codex rollout is `rollout-<ts>-<uuid>.jsonl` under a
 * date-partitioned path, so that walk cannot match one by construction — on one
 * live machine it answered 0 of 343 Codex conversations, and 64% overall.
 *
 * The ladder consults what is already known: the live PTY map, then the path the
 * cache recorded, then the walk as a self-heal. The cached path is verified
 * rather than trusted, because 49 of 961 rows on that machine pointed at a
 * subagent transcript of the conversation instead of the conversation.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationHandlers } from "../src/api/handlers/conversations.handlers";

function makeHandlers(opts: {
  projectsDir?: string;
  cachedPath?: string;
  livePath?: string;
}): ConversationHandlers {
  return new ConversationHandlers({
    scannerManager: { projectsDirs: () => (opts.projectsDir ? [opts.projectsDir] : []) },
    cache: () => (opts.cachedPath ? { getMetaById: () => ({ filePath: opts.cachedPath }) } : null),
    findLiveSessionFilePath: () => opts.livePath ?? null,
    resolveConversationLookupId: (id: string) => id,
  } as unknown as ConstructorParameters<typeof ConversationHandlers>[0]);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-locator-"));
});

describe("locateJsonlPath", () => {
  it("resolves a Codex rollout, which the directory walk never can", async () => {
    const id = "019f3a52-390e-74e1-b89c-f982288a5d1c";
    const rollout = join(dir, `rollout-2026-07-07T05-04-54-${id}.jsonl`);
    writeFileSync(rollout, `${JSON.stringify({ type: "session_meta" })}\n`);

    const h = makeHandlers({ cachedPath: rollout });
    expect(await h.locateJsonlPath(id, id)).toBe(rollout);
    // The control: the walk alone still cannot find it.
    expect(h.findJsonlPath(id)).toBeNull();
  });

  it("prefers a live session's file over the cached path", async () => {
    const id = "live-conv";
    const cached = join(dir, `${id}.jsonl`);
    const live = join(dir, "live.jsonl");
    writeFileSync(cached, "{}\n");
    writeFileSync(live, "{}\n");

    const h = makeHandlers({ cachedPath: cached, livePath: live });
    expect(await h.locateJsonlPath(id, id)).toBe(live);
  });

  it("falls through to the walk when the cached path is gone", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const projects = join(dir, "projects");
    const real = join(projects, "-some-project", `${id}.jsonl`);
    mkdirSync(join(projects, "-some-project"), { recursive: true });
    writeFileSync(real, "{}\n");

    const h = makeHandlers({ projectsDir: projects, cachedPath: join(dir, "vanished.jsonl") });
    expect(await h.locateJsonlPath(id, id)).toBe(real);
  });

  it("rejects a cached path pointing at a subagent transcript, and self-heals", async () => {
    // The 49-row case: the parent's row was overwritten with one of its own
    // sidechains, whose first line carries the PARENT's sessionId — so a
    // sessionId match alone verifies exactly the wrong file.
    const parentId = "05e3f02a-3e35-400e-8896-b6abfbf617f9";
    const projects = join(dir, "projects");
    const proj = join(projects, "-p");
    mkdirSync(join(proj, "subagents"), { recursive: true });

    const sidechain = join(proj, "subagents", "agent-a8b1c9da57d11ae68.jsonl");
    writeFileSync(
      sidechain,
      `${JSON.stringify({ sessionId: parentId, isSidechain: true, agentId: "a8b1c9da57d11ae68" })}\n`,
    );
    const parent = join(proj, `${parentId}.jsonl`);
    writeFileSync(parent, `${JSON.stringify({ sessionId: parentId })}\n`);

    const h = makeHandlers({ projectsDir: projects, cachedPath: sidechain });
    expect(await h.locateJsonlPath(parentId, parentId)).toBe(parent);
  });

  it("still serves a sidechain when it is asked for by its own agent id", async () => {
    const agentId = "agent-a8b1c9da57d11ae68";
    const sidechain = join(dir, `${agentId}.jsonl`);
    writeFileSync(
      sidechain,
      `${JSON.stringify({ sessionId: "some-parent", isSidechain: true })}\n`,
    );

    const h = makeHandlers({ cachedPath: sidechain });
    expect(await h.locateJsonlPath(agentId, agentId)).toBe(sidechain);
  });

  it("returns null when the file is genuinely gone — the archive's case", async () => {
    const h = makeHandlers({ cachedPath: join(dir, "nope.jsonl") });
    expect(await h.locateJsonlPath("missing", "missing")).toBeNull();
  });
});
