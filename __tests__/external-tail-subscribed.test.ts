import {
  EXTERNAL_TAIL_IDLE_MS,
  type ExternalTailEntry,
  ExternalTailManager,
  SUBSCRIBED_TAIL_IDLE_MS,
} from "../src/external-tails";

/** Turn-end push hook and the longer idle limit for a subscribed tail (#1265). */

const ID = "11111111-2222-3333-4444-555555555555";
const FILE = `/p/${ID}.jsonl`;
const NOW = 1_000_000_000_000;

function build(extra: Record<string, unknown> = {}) {
  const tails = new Map<string, ExternalTailEntry>([
    [FILE, { conversationId: ID, lastActivityAt: NOW }],
  ]);
  const unwatch = vi.fn();
  const onTurnLines = vi.fn();
  const excluded = { value: false };
  const mgr = new ExternalTailManager({
    tails,
    sessionFileMap: new Map(),
    fileWatcher: { watch: () => {}, unwatch } as any,
    wsHub: { broadcast: () => {} } as any,
    cache: () =>
      ({
        getIdByFilePath: () => ID,
        isExcludedSubagent: () => excluded.value,
        getMetaById: () => null,
      }) as any,
    cacheMonitor: () => null,
    broadcastConversationLines: () => {},
    onTurnLines,
    ...extra,
  });
  return { mgr, tails, unwatch, onTurnLines, excluded };
}

describe("turn-end hook", () => {
  it("hands the appended lines to onTurnLines with the conversation id", () => {
    const { mgr, onTurnLines } = build();
    mgr.broadcastExternalTailLines(FILE, ["a", "b"]);
    expect(onTurnLines).toHaveBeenCalledWith(ID, ["a", "b"]);
  });

  it("does not hand over lines of a hidden subagent conversation", () => {
    const { mgr, onTurnLines, excluded } = build();
    excluded.value = true;
    mgr.broadcastExternalTailLines(FILE, ["a"]);
    expect(onTurnLines).not.toHaveBeenCalled();
  });
});

describe("idle sweep", () => {
  it("detaches an unsubscribed tail after the default idle limit", () => {
    const { mgr, tails } = build({ hasSubscribers: () => false });
    mgr.sweepIdleExternalTails(NOW + EXTERNAL_TAIL_IDLE_MS + 1);
    expect(tails.size).toBe(0);
  });

  it("keeps a subscribed tail past the default limit", () => {
    const { mgr, tails } = build({ hasSubscribers: (id: string) => id === ID });
    mgr.sweepIdleExternalTails(NOW + EXTERNAL_TAIL_IDLE_MS + 1);
    expect(tails.size).toBe(1);
  });

  it("detaches a subscribed tail after the subscribed limit", () => {
    const { mgr, tails } = build({ hasSubscribers: () => true });
    mgr.sweepIdleExternalTails(NOW + SUBSCRIBED_TAIL_IDLE_MS + 1);
    expect(tails.size).toBe(0);
  });
});
