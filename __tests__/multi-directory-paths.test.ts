import {
  mkdirSync,
  mkdtempSync,
  realpathSync as nodeRealpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { dropCoveredPaths, resolveAdditionalPaths } from "../src/browse";
import { withAdditionalDirs } from "../src/claude-flags";
import {
  ManagedSessionsRepository,
  parseAdditionalPaths,
} from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { AdditionalPathsSchema, MAX_ADDITIONAL_PATHS } from "../src/schemas/sessionStart.schema";
import { rowToStubSession } from "../src/services/sessions/rehydrateSessions";
import type { ManagedSession } from "../src/types";

// libuv's realpath, the one the server uses: the JS one keeps Windows 8.3 short
// names (`RUNNER~1`), so the two disagree on a CI runner's temp dir.
const realpathSync = nodeRealpathSync.native;

// Native paths, like everything `resolveBrowsePath` hands this function: nesting
// is judged on the platform separator, so POSIX literals would not nest on Windows.
const w = (...parts: string[]) => join(sep, "w", ...parts);

describe("dropCoveredPaths", () => {
  it("drops the primary, duplicates, and anything nested inside a kept path", () => {
    expect(
      dropCoveredPaths(w("app"), [
        w("lib"),
        w("app"),
        w("app", "src"),
        w("lib"),
        w("lib", "sub"),
        w("docs"),
      ]),
    ).toEqual([w("lib"), w("docs")]);
  });

  it("keeps a parent listed after its child, in the caller's position", () => {
    expect(dropCoveredPaths(w("app"), [w("lib", "sub"), w("other"), w("lib")])).toEqual([
      w("other"),
      w("lib"),
    ]);
  });

  it("does not treat a shared name prefix as nesting", () => {
    expect(dropCoveredPaths(w("app"), [w("app-old"), w("lib"), w("library")])).toEqual([
      w("app-old"),
      w("lib"),
      w("library"),
    ]);
  });

  it("keeps a directory that contains the primary", () => {
    expect(dropCoveredPaths(w("app", "pkg"), [w("app")])).toEqual([w("app")]);
  });
});

describe("resolveAdditionalPaths", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "threadbase-multidir-")));
    mkdirSync(join(root, "app", "src"), { recursive: true });
    mkdirSync(join(root, "lib"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "notes.txt"), "x");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves entries under the browse root and drops covered ones", async () => {
    const out = await resolveAdditionalPaths(root, join(root, "app"), [
      "lib",
      "app/src",
      "docs/",
      "lib",
    ]);
    expect(out).toEqual([join(root, "lib"), join(root, "docs")]);
  });

  it("rejects an entry outside the browse root", async () => {
    await expect(resolveAdditionalPaths(root, join(root, "app"), ["../"])).rejects.toThrow(
      "outside browse root",
    );
  });

  it("rejects an entry that does not exist", async () => {
    await expect(resolveAdditionalPaths(root, join(root, "app"), ["gone"])).rejects.toThrow(
      "Path not found",
    );
  });

  it("rejects a file", async () => {
    await expect(resolveAdditionalPaths(root, join(root, "app"), ["notes.txt"])).rejects.toThrow(
      "Not a directory",
    );
  });
});

describe("AdditionalPathsSchema", () => {
  it("accepts up to the cap and rejects anything else", () => {
    const atCap = Array.from({ length: MAX_ADDITIONAL_PATHS }, (_, i) => `d${i}`);
    expect(AdditionalPathsSchema.safeParse(atCap).success).toBe(true);
    expect(AdditionalPathsSchema.safeParse([...atCap, "one-more"]).success).toBe(false);
    expect(AdditionalPathsSchema.safeParse("lib").success).toBe(false);
    expect(AdditionalPathsSchema.safeParse(["lib", 3]).success).toBe(false);
    expect(AdditionalPathsSchema.safeParse(["  "]).success).toBe(false);
  });
});

describe("withAdditionalDirs", () => {
  it("returns the flags untouched when there are no extra directories", () => {
    const flags = { model: "opus" };
    expect(withAdditionalDirs(flags, undefined)).toBe(flags);
    expect(withAdditionalDirs(flags, [])).toBe(flags);
  });

  it("appends to the server-wide addDir and drops repeats", () => {
    expect(withAdditionalDirs({ addDir: ["/a", "/b"], model: "opus" }, ["/b", "/c"])).toEqual({
      addDir: ["/a", "/b", "/c"],
      model: "opus",
    });
    expect(withAdditionalDirs(undefined, ["/c"])).toEqual({ addDir: ["/c"] });
  });
});

describe("additional_paths persistence", () => {
  let dbDir: string;
  let store: RuntimeStore;
  let repo: ManagedSessionsRepository;

  function session(over: Partial<ManagedSession> = {}): ManagedSession {
    return {
      id: "sess-1",
      provider: "claude-code",
      projectPath: "/w/app",
      projectName: "app",
      branch: "main",
      status: "running",
      startedAt: new Date("2026-10-05T10:00:00Z"),
      completedAt: null,
      promptCount: 1,
      lastOutput: "",
      ...over,
    };
  }

  function record(s: ManagedSession): void {
    repo.recordSpawn({ session: s, pid: null, cmdline: null, streamerInstanceId: "test" });
  }

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "threadbase-multidir-db-"));
    store = RuntimeStore.open(join(dbDir, "runtime.db"));
    repo = new ManagedSessionsRepository(store.getDatabase());
  });

  afterEach(() => {
    store.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("round-trips through recordSpawn and the rehydrated stub", () => {
    record(session({ additionalPaths: ["/w/lib", "/w/docs"] }));

    const row = repo.get("sess-1");
    expect(row?.additional_paths).toBe(JSON.stringify(["/w/lib", "/w/docs"]));
    expect(repo.findAdditionalPaths("sess-1")).toEqual(["/w/lib", "/w/docs"]);
    // biome-ignore lint/style/noNonNullAssertion: asserted just above
    expect(rowToStubSession(row!).additionalPaths).toEqual(["/w/lib", "/w/docs"]);
  });

  it("stores NULL when there are none, and a re-record clears earlier ones", () => {
    record(session({ additionalPaths: ["/w/lib"] }));
    record(session());

    expect(repo.get("sess-1")?.additional_paths).toBeNull();
    expect(repo.findAdditionalPaths("sess-1")).toEqual([]);
    // biome-ignore lint/style/noNonNullAssertion: recorded above
    expect(rowToStubSession(repo.get("sess-1")!)).not.toHaveProperty("additionalPaths");
  });

  // Codex rows are keyed by a placeholder; a resume asks by the rollout id.
  it("finds a row by the conversation it was bound to", () => {
    record(
      session({
        id: "placeholder",
        provider: "codex-cli",
        boundConversationId: "rollout-id",
        additionalPaths: ["/w/lib"],
      }),
    );

    expect(repo.findAdditionalPaths("rollout-id")).toEqual(["/w/lib"]);
    expect(repo.findAdditionalPaths("unknown")).toEqual([]);
  });

  it("reads a malformed column as none", () => {
    expect(parseAdditionalPaths("not json")).toEqual([]);
    expect(parseAdditionalPaths('{"a":1}')).toEqual([]);
    expect(parseAdditionalPaths('["/w/lib", 3]')).toEqual(["/w/lib"]);
    expect(parseAdditionalPaths(null)).toEqual([]);
  });
});
