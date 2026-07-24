import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CLI_CAPABILITIES,
  capabilitiesFor,
  GENERIC_TERMINAL_CAPABILITIES,
} from "../src/services/providers/capabilities";

const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/**
 * Codex runner source with comments and blank lines stripped, so assertions
 * about which flags are PASSED aren't satisfied by comments that merely mention
 * a flag while explaining that Codex doesn't have it.
 */
function codexSpawnArgs(): string {
  return read("codex-pty-runner.ts")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/**
 * Declared capabilities are only useful if they are TRUE. A capability table
 * that drifts from the runner it describes is worse than no table: clients hide
 * or show actions based on it.
 *
 * These tests anchor each declaration to the code that implements it, so a
 * runner change that contradicts the declaration fails here rather than
 * surfacing as a mysteriously missing button in the app.
 */
describe("declared capabilities match runner behaviour", () => {
  describe("claude-code", () => {
    it("declares explicit fresh session ids, and the runner passes --session-id", () => {
      expect(CLAUDE_CODE_CAPABILITIES.freshSessionId).toBe("explicit");
      expect(read("pty-manager.ts")).toContain("--session-id");
    });

    it("declares native resume, and the runner passes --resume", () => {
      expect(CLAUDE_CODE_CAPABILITIES.resume).toBe("native");
      expect(read("pty-manager.ts")).toContain("--resume");
    });

    it("declares a system-prompt flag, and the runner passes --system-prompt", () => {
      expect(CLAUDE_CODE_CAPABILITIES.systemPrompt).toBe("flag");
      expect(read("pty-manager.ts")).toContain("--system-prompt");
    });

    it("declares structured questions, and the detector exists", () => {
      expect(CLAUDE_CODE_CAPABILITIES.structuredQuestions).toBe(true);
      expect(read("services/questions/detectQuestionFromScreen.ts")).toContain("Enter to select");
    });
  });

  describe("codex-cli", () => {
    // Codex has no --session-id equivalent: the CLI creates its own rollout id
    // and the streamer discovers it afterwards by watching the sessions dir.
    //
    // Assert against the argv the runner BUILDS, not the raw file — the flag
    // names appear in comments there explaining their absence, so a substring
    // search over the source would fail for the wrong reason.
    it("declares late-bound session ids, and no spawn passes --session-id", () => {
      expect(CODEX_CLI_CAPABILITIES.freshSessionId).toBe("late-bound");
      expect(codexSpawnArgs()).not.toContain("--session-id");
    });

    it("declares native resume, and the runner spawns `resume`", () => {
      expect(CODEX_CLI_CAPABILITIES.resume).toBe("native");
      expect(codexSpawnArgs()).toContain('"resume"');
    });

    // Codex takes the prompt as the opening positional turn — there is no flag.
    it("declares a positional system prompt, and no spawn passes a prompt flag", () => {
      expect(CODEX_CLI_CAPABILITIES.systemPrompt).toBe("positional");
      expect(codexSpawnArgs()).not.toContain("--system-prompt");
    });

    // We parse Codex's trust/hooks gates, but it has no AskUserQuestion-style
    // structured menu we understand.
    it("declares gates but not structured questions", () => {
      expect(CODEX_CLI_CAPABILITIES.permissionGates).toBe(true);
      expect(CODEX_CLI_CAPABILITIES.structuredQuestions).toBe(false);
      expect(read("codex-pty-runner.ts")).toContain("CODEX_TRUST_GATE_REGEX");
    });
  });

  describe("generic terminal fallback", () => {
    // The honest state for a provider we do not recognize. Today
    // coerceProviderForRunner silently drives an unknown provider with the
    // Claude runner, which asserts capabilities it has no basis for.
    it("claims no semantic understanding but still allows input", () => {
      expect(GENERIC_TERMINAL_CAPABILITIES.structuredQuestions).toBe(false);
      expect(GENERIC_TERMINAL_CAPABILITIES.permissionGates).toBe(false);
      expect(GENERIC_TERMINAL_CAPABILITIES.resume).toBe("unsupported");
      expect(GENERIC_TERMINAL_CAPABILITIES.liveControl).toBe(true);
    });

    it("is strictly weaker than every real provider's claims", () => {
      for (const real of [CLAUDE_CODE_CAPABILITIES, CODEX_CLI_CAPABILITIES]) {
        expect(real.structuredQuestions || !GENERIC_TERMINAL_CAPABILITIES.structuredQuestions).toBe(
          true,
        );
        expect(real.permissionGates || !GENERIC_TERMINAL_CAPABILITIES.permissionGates).toBe(true);
      }
    });
  });

  it("resolves capabilities for every known provider", () => {
    expect(capabilitiesFor("claude-code")).toBe(CLAUDE_CODE_CAPABILITIES);
    expect(capabilitiesFor("codex-cli")).toBe(CODEX_CLI_CAPABILITIES);
  });
});
