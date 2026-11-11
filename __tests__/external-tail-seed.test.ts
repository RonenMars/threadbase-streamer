import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalTailManager } from "../src/external-tails";

const ID = "11111111-2222-3333-4444-555555555555";

describe("external tail attach", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-ext-seed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports lastEventAt at the file's mtime, not the attach time", () => {
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(file, "{}\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const mgr = new ExternalTailManager({
      tails: new Map(),
      sessionFileMap: new Map(),
      fileWatcher: { watch: () => {} } as any,
      wsHub: {} as any,
      cache: () => null,
      cacheMonitor: () => null,
      broadcastConversationLines: () => {},
    });
    mgr.maybeAttachExternalTail(file);
    const activity = mgr.externalActivityFor(ID);
    expect(activity?.lastEventAt).toBe(new Date(statSync(file).mtimeMs).toISOString());
  });
});
