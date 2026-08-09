/**
 * Fix 2: the bounded exact-rollout open-file pre-flight.
 *
 * The probe's whole value is that a null result is *not* a claim — every
 * unhappy path (timeout, missing lsof, permission denial, junk output) has to
 * fall through to the authoritative post-spawn handshake rather than being read
 * as "the rollout is free".
 */
import { findRolloutOwner, parseLsofFieldOutput } from "../src/services/sessions/codexRolloutOwner";

const ROLLOUT = "/home/u/.codex/sessions/2026/08/09/rollout-2026-08-09T00-43-56-019fe355.jsonl";

// `lsof -F pc` output: one `p<pid>` line per process, then its `c<command>`.
const LSOF_CODEX = "p9935\nccodex\nf12\n";

describe("parseLsofFieldOutput", () => {
  it("pairs each pid with its command", () => {
    expect(parseLsofFieldOutput("p9935\nccodex\np404\ncnode\n")).toEqual([
      { pid: 9935, command: "codex" },
      { pid: 404, command: "node" },
    ]);
  });

  it("ignores junk, and a command line with no preceding pid", () => {
    expect(parseLsofFieldOutput("")).toEqual([]);
    expect(parseLsofFieldOutput("cstray\nnonsense\n")).toEqual([]);
    expect(parseLsofFieldOutput("pnotanumber\nccodex\n")).toEqual([]);
  });
});

describe("findRolloutOwner", () => {
  it("reports the foreign process holding the exact rollout open", async () => {
    const seen: string[] = [];
    const owner = await findRolloutOwner(ROLLOUT, {
      platform: "darwin",
      selfPid: 1,
      run: async (path) => {
        seen.push(path);
        return LSOF_CODEX;
      },
    });

    // Queried the exact path — never a scan of every rollout.
    expect(seen).toEqual([ROLLOUT]);
    expect(owner).toEqual({ pid: 9935, command: "codex", source: "terminal" });
  });

  it("leaves an unrecognised owner unclassified rather than guessing a TUI", async () => {
    const owner = await findRolloutOwner(ROLLOUT, {
      platform: "linux",
      selfPid: 1,
      run: async () => "p700\nccode\n",
    });
    // A VS Code / desktop app-server can host unrelated threads; calling it a
    // standalone terminal is what would make a destructive action look safe.
    expect(owner).toEqual({ pid: 700, command: "code", source: "unknown" });
  });

  it("does not report ourselves as the owner", async () => {
    const owner = await findRolloutOwner(ROLLOUT, {
      platform: "darwin",
      selfPid: 9935,
      run: async () => LSOF_CODEX,
    });
    expect(owner).toBeNull();
  });

  it("falls through on an unsupported platform without running anything", async () => {
    let ran = false;
    const owner = await findRolloutOwner(ROLLOUT, {
      platform: "win32",
      run: async () => {
        ran = true;
        return LSOF_CODEX;
      },
    });
    expect(owner).toBeNull();
    expect(ran).toBe(false);
  });

  it("falls through when the probe times out or lsof is unavailable", async () => {
    for (const err of [new Error("ETIMEDOUT"), Object.assign(new Error("spawn lsof"), {})]) {
      const owner = await findRolloutOwner(ROLLOUT, {
        platform: "darwin",
        run: async () => {
          throw err;
        },
      });
      expect(owner).toBeNull();
    }
  });

  it("reports no owner when nothing holds the file (positive control below)", async () => {
    const empty = await findRolloutOwner(ROLLOUT, {
      platform: "darwin",
      selfPid: 1,
      run: async () => "",
    });
    expect(empty).toBeNull();
    // Same probe, same options, output present → non-null. Without this the
    // assertion above would also pass if the parser were broken.
    const found = await findRolloutOwner(ROLLOUT, {
      platform: "darwin",
      selfPid: 1,
      run: async () => LSOF_CODEX,
    });
    expect(found?.pid).toBe(9935);
  });
});
