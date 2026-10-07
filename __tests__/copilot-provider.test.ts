import { canonicalizeProviderName, commandNameForProvider } from "../src/providers";
import { capabilitiesFor } from "../src/services/providers/capabilities";
import { providerHealth } from "../src/services/providers/providerHealth";

describe("Copilot provider contract", () => {
  it("routes the wire name to its own executable", () => {
    expect(canonicalizeProviderName("copilot")).toBe("copilot");
    expect(commandNameForProvider("copilot" as any)).toBe("copilot");
  });
  it("supports explicit native sessions without claiming TUI semantics", () => {
    expect(capabilitiesFor("copilot" as any)).toEqual({
      freshSessionId: "explicit",
      resume: "native",
      systemPrompt: "unsupported",
      structuredQuestions: false,
      permissionGates: false,
      liveControl: true,
    });
  });
  it("reports missing CLI and unverified installed versions honestly", async () => {
    expect((await providerHealth("copilot" as any, () => null)).available).toBe(false);
    const health = await providerHealth(
      "copilot" as any,
      () => "/bin/copilot",
      async () => "1.0.88",
    );
    expect(health.available).toBe(true);
    expect(health.warnings.map((w) => w.code)).toContain("version_unverified");
  });
});

import { extractConversationId, providerForCommandLine } from "../src/process-discovery";

describe("Copilot process discovery", () => {
  it("finds interactive sessions and explicit IDs", () => {
    expect(
      providerForCommandLine("/opt/homebrew/bin/copilot -C /tmp/project --session-id=abc"),
    ).toBe("copilot");
    expect(extractConversationId("copilot --session-id=abc", "copilot")).toBe("abc");
    expect(extractConversationId("copilot --resume abc", "copilot")).toBe("abc");
    expect(extractConversationId("copilot --continue", "copilot")).toBeNull();
    expect(providerForCommandLine("copilot -C /tmp/project --model help")).toBe("copilot");
  });
  it.each([
    "copilot login",
    "copilot --help",
    "copilot --prompt=hello",
    "copilot --acp",
    "copilot mcp",
    "gh copilot",
  ])("excludes %s", (command) => {
    expect(providerForCommandLine(command)).toBeNull();
  });
});
