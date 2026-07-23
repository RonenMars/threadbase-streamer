import { parseStatusLine } from "../src/services/questions/parseStatusLine";

// Captured verbatim from a live `claude` PTY rendered through the same headless
// xterm the streamer uses (120x40). Keep these literal — the parser exists to
// track Claude Code's real footer, so a synthetic approximation would let a
// rendering change pass unnoticed.
const REAL_FOOTER = [
  " ⚠ 3 MCP servers need authentication · run /mcp",
  "",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
  "  Opus 4.8 (1M context) │ ~/dev/ai-tools/tb-streamer  integration-dev/v1.0.0-2026-07-22 ✎ │  26.5.0 23:41 │ ⚓4",
  "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  "                                                      ● high · /effort",
];

describe("parseStatusLine", () => {
  it("extracts model, effort and permission mode from a real footer", () => {
    expect(parseStatusLine(REAL_FOOTER)).toEqual({
      model: "Opus 4.8 (1M context)",
      effort: "high",
      permissionMode: "accept edits on",
    });
  });

  it("parses a model with no parenthetical suffix", () => {
    // Sonnet renders bare ("Sonnet 5"), unlike Opus's "(1M context)".
    expect(parseStatusLine(["  Sonnet 5 │ ~/dev/ai-tools/tb-streamer │ 23:41"]).model).toBe(
      "Sonnet 5",
    );
  });

  it("returns an empty object when no footer is on screen", () => {
    expect(parseStatusLine(["just some output", "❯ ", ""])).toEqual({});
  });

  it("does not mistake a path or branch cell for a model", () => {
    expect(
      parseStatusLine(["  ~/dev/ai-tools/tb-streamer │ main ✎ │ 23:41"]).model,
    ).toBeUndefined();
  });

  it("prefers the most recent footer when scrollback holds an older one", () => {
    const lines = [
      "  Sonnet 5 │ ~/x",
      "                ● low · /effort",
      "some later output",
      "  Opus 4.8 (1M context) │ ~/x",
      "                ● max · /effort",
    ];
    const got = parseStatusLine(lines);
    expect(got.model).toBe("Opus 4.8 (1M context)");
    expect(got.effort).toBe("max");
  });

  it("captures an unknown effort tier rather than dropping it", () => {
    expect(parseStatusLine(["  ● xhigh · /effort"]).effort).toBe("xhigh");
  });

  it("ignores the elapsed counter (client animates it locally)", () => {
    const got = parseStatusLine(["✽ Swirling… (56s · ↑ 3.4k tokens)"]);
    expect(got).toEqual({});
  });
});
