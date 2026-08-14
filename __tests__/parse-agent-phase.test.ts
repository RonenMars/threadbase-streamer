import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER } from "../src/providers";
import { parseAgentPhase } from "../src/services/questions/parseAgentPhase";

// Captured Codex status bars (live PTY probe, Phase 0 findings).
const CODEX_WORKING = "gpt-5.5 medium · /Users/x/dev/tb · gpt-5.5 · medium · Working · Wo…";
const CODEX_READY = "gpt-5.5 medium · /Users/x/dev/tb · gpt-5.5 · medium · Ready · Wo…";
const CODEX_STARTING = "gpt-5.5 medium · /Users/x/dev/tb · gpt-5.5 · medium · Starting · Wo…";

describe("parseAgentPhase — codex", () => {
  it("reports working while the status bar says Working", () => {
    expect(parseAgentPhase([CODEX_WORKING], CODEX_CLI_PROVIDER)).toBe("working");
  });

  it("reports no phase when the composer is Ready", () => {
    expect(parseAgentPhase([CODEX_READY], CODEX_CLI_PROVIDER)).toBeNull();
  });

  // The phase describes what the agent is doing *within* a turn. Three screens
  // keep the composer shut before any turn exists, and a status-bar-only read
  // reports all three as working — while the session is still booting, or is
  // frozen waiting on the user. The runner scrapes whenever its status is
  // `running`, which covers the whole pendingReady boot window, so these are
  // reachable rather than theoretical.
  it("reports no phase while MCP servers are Starting", () => {
    expect(parseAgentPhase([CODEX_STARTING], CODEX_CLI_PROVIDER)).toBeNull();
  });

  it("reports no phase during MCP boot progress", () => {
    const screen = ["Booting MCP servers…", CODEX_WORKING];
    expect(parseAgentPhase(screen, CODEX_CLI_PROVIDER)).toBeNull();
  });

  it("reports no phase while a blocking startup gate is on screen", () => {
    const trust = [
      "Do you trust the contents of this directory?",
      "1. Yes, continue",
      CODEX_WORKING,
    ];
    expect(parseAgentPhase(trust, CODEX_CLI_PROVIDER)).toBeNull();

    const hooks = ["Your hooks need review", "2. Trust all and continue", CODEX_WORKING];
    expect(parseAgentPhase(hooks, CODEX_CLI_PROVIDER)).toBeNull();
  });

  it("reads the last non-blank line, not the last line", () => {
    const screen = ["some output", CODEX_WORKING, "", "   "];
    expect(parseAgentPhase(screen, CODEX_CLI_PROVIDER)).toBe("working");
  });

  // PRE-EXISTING LIMITATION, documented rather than asserted-away. The status
  // bar carries the cwd, and both CODEX_BUSY_STATUS_RE and the phase's
  // CODEX_WORKING_STATUS_RE match `Working` as a whole word — which their
  // comments claim stops a project path from false-hitting. It does not: `/` is
  // a non-word character, so `\b` matches at a path boundary and
  // `/Users/x/Working/repo` tests true even on a Ready bar.
  //
  // This affects codexScreenBlocksComposer() and codexScreenShowsReady() today,
  // independently of this feature — a session under a path segment named
  // "Working" or "Starting" never reads as ready. Filed separately; this test
  // pins current behaviour so the fix has something to flip.
  it("inherits the status-bar path false-positive (known, filed separately)", () => {
    const screen = ["gpt-5.5 · /Users/x/Working/repo · gpt-5.5 · medium · Ready · Wo…"];
    expect(parseAgentPhase(screen, CODEX_CLI_PROVIDER)).toBe("working");
  });

  it("reports no phase for an empty screen", () => {
    expect(parseAgentPhase([], CODEX_CLI_PROVIDER)).toBeNull();
    expect(parseAgentPhase(["", "  "], CODEX_CLI_PROVIDER)).toBeNull();
  });
});

describe("parseAgentPhase — claude", () => {
  // The Claude grammar is deliberately unimplemented until its markers are
  // re-verified against a fresh PTY capture. Until then it must report no
  // phase rather than guess — a wrong phase is worse than none.
  it("reports no phase pending marker re-verification", () => {
    const footer = "✽ Roosting… (5s · ↓ 82 tokens)";
    expect(parseAgentPhase([footer], CLAUDE_CODE_PROVIDER)).toBeNull();
  });
});

describe("parseAgentPhase — unknown provider", () => {
  it("makes no claim rather than falling back to another provider's grammar", () => {
    // Codex's own bar, read as some future provider: must not be interpreted.
    expect(parseAgentPhase([CODEX_WORKING], "some-future-cli" as never)).toBeNull();
  });
});
