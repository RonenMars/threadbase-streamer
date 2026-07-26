// handlePermissionChange re-fires on every PTY repaint tick (~2/Hz) for as
// long as a gate stays open, even when the gate content is unchanged — prod
// logs showed 200 identical `permission` broadcasts over 65s for one gate.
// handleLiveQuestion already dedupes via a content key; this locks the same
// behavior into handlePermissionChange.

import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import type { StreamerServer } from "../src/server";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("handlePermissionChange — broadcast dedup", () => {
  let server: StreamerServer;
  let cacheDir: string;
  let broadcasts: Array<{ type: string }>;

  beforeAll(async () => {
    const { StreamerServer } = await import("../src/server");
    const port = await getRandomPort();
    cacheDir = mkdtempSync(join(tmpdir(), "tb-perm-dedup-cache-"));
    server = new StreamerServer({
      port,
      apiKey: "tb_test_perm_dedup",
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(port);
  });

  afterAll(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    broadcasts = [];
    vi.spyOn((server as any).wsHub, "broadcast").mockImplementation((...args: unknown[]) => {
      broadcasts.push(args[0] as { type: string });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not re-broadcast when the same gate repaints with identical content", () => {
    const SID = "repaint-sess";
    const gate = {
      prompt: "Do you want to proceed?",
      options: [
        { index: 1, label: "Yes" },
        { index: 2, label: "Yes, and don't ask again" },
        { index: 3, label: "No" },
      ],
      cursor: 1,
    };

    (server as any).handlePermissionChange(SID, gate);
    (server as any).handlePermissionChange(SID, { ...gate });
    (server as any).handlePermissionChange(SID, { ...gate });

    expect(broadcasts.filter((b) => b.type === "permission")).toHaveLength(1);
  });

  it("re-broadcasts when the cursor moves within the same gate", () => {
    const SID = "cursor-move-sess";
    const base = {
      prompt: "Do you want to proceed?",
      options: [
        { index: 1, label: "Yes" },
        { index: 2, label: "No" },
      ],
    };

    (server as any).handlePermissionChange(SID, { ...base, cursor: 1 });
    (server as any).handlePermissionChange(SID, { ...base, cursor: 2 });

    expect(broadcasts.filter((b) => b.type === "permission")).toHaveLength(2);
  });

  it("re-broadcasts when the gate content actually changes", () => {
    const SID = "content-change-sess";

    (server as any).handlePermissionChange(SID, {
      prompt: "Do you want to proceed?",
      options: [{ index: 1, label: "Yes" }],
    });
    (server as any).handlePermissionChange(SID, {
      prompt: "Different prompt now",
      options: [{ index: 1, label: "Yes" }],
    });

    expect(broadcasts.filter((b) => b.type === "permission")).toHaveLength(2);
  });

  it("broadcasts permission_cancelled once when the gate closes, not on repeated nulls", () => {
    const SID = "close-sess";
    (server as any).handlePermissionChange(SID, {
      prompt: "Do you want to proceed?",
      options: [{ index: 1, label: "Yes" }],
    });
    broadcasts = [];

    (server as any).handlePermissionChange(SID, null);
    (server as any).handlePermissionChange(SID, null);

    expect(broadcasts.filter((b) => b.type === "permission_cancelled")).toHaveLength(1);
  });

  it("re-opening the same gate after it closed broadcasts again", () => {
    const SID = "reopen-sess";
    const gate = {
      prompt: "Do you want to proceed?",
      options: [{ index: 1, label: "Yes" }],
    };

    (server as any).handlePermissionChange(SID, gate);
    (server as any).handlePermissionChange(SID, null);
    (server as any).handlePermissionChange(SID, { ...gate });

    expect(broadcasts.filter((b) => b.type === "permission")).toHaveLength(2);
  });
});
