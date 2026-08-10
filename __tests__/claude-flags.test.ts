import {
  buildFlagArgs,
  buildSettingsJson,
  CLAUDE_FLAGS,
  EFFORT_LEVELS,
  effectivePermissionMode,
  flagValueRisk,
  isEffortLevel,
  isPermissionMode,
  tokenizeExtraArgs,
  validateFlagValues,
} from "../src/claude-flags";

describe("validateFlagValues", () => {
  it("keeps well-typed known ids", () => {
    expect(
      validateFlagValues({
        permissionMode: "bypassPermissions",
        addDir: ["/a", "/b"],
        model: "opus",
      }),
    ).toEqual({
      permissionMode: "bypassPermissions",
      addDir: ["/a", "/b"],
      model: "opus",
    });
  });

  // The registry is a trust boundary: these values become process argv, and
  // server.yaml is hand-editable. Anything unrecognised is dropped, never passed
  // through and never thrown on (a bad key must not stop the server booting).
  it("drops unknown ids", () => {
    expect(validateFlagValues({ notAFlag: "x", "--add-dir": "/a" })).toEqual({});
  });

  it("drops values of the wrong type", () => {
    expect(validateFlagValues({ addDir: "/not-an-array" })).toEqual({});
    expect(validateFlagValues({ model: 5 })).toEqual({});
    expect(validateFlagValues({ permissionMode: "notAMode" })).toEqual({});
  });

  it("drops empty strings and empty lists", () => {
    expect(validateFlagValues({ model: "   ", addDir: [] })).toEqual({});
  });

  it("keeps model and effort", () => {
    expect(validateFlagValues({ model: "claude-opus-4-5", effort: "xhigh" })).toEqual({
      model: "claude-opus-4-5",
      effort: "xhigh",
    });
  });

  it("drops an off-registry effort level", () => {
    expect(validateFlagValues({ effort: "turbo" })).toEqual({});
  });

  it("tolerates non-object input", () => {
    expect(validateFlagValues(null)).toEqual({});
    expect(validateFlagValues(["addDir"])).toEqual({});
    expect(validateFlagValues("addDir=/a")).toEqual({});
  });
});

describe("buildFlagArgs", () => {
  it("emits list flags in variadic form", () => {
    expect(buildFlagArgs({ addDir: ["/a", "/b"] })).toEqual(["--add-dir", "/a", "/b"]);
  });

  // No "emits string flags" case: since --max-budget-usd and --fallback-model
  // were removed (both --print-only, so both were no-ops here), `model` is the
  // only string flag left and it is positional, i.e. skipped. The string branch
  // of buildFlagArgs is now unreachable through the registry — kept as-is so the
  // next string flag added works without touching it.

  // permissionMode is passed as an explicit positional by both PTY spawn paths;
  // emitting it here too would put --permission-mode on the argv twice.
  it("never emits permissionMode", () => {
    expect(buildFlagArgs({ permissionMode: "bypassPermissions" })).toEqual([]);
  });

  // Same reason as permissionMode: both spawn paths already pass --model and
  // --effort positionally, sourced from these very values via
  // StreamerServer.spawnFlagOverrides(). Emitting them here would duplicate the
  // flag on the command line.
  it("never emits model or effort", () => {
    expect(buildFlagArgs({ model: "opus", effort: "high" })).toEqual([]);
  });

  // Regression guard against widening the skip set too far: a non-positional
  // flag alongside positional ones must still reach argv.
  it("still emits non-positional flags when positional ones are present", () => {
    expect(buildFlagArgs({ addDir: ["/a"], model: "opus", effort: "high" })).toEqual([
      "--add-dir",
      "/a",
    ]);
  });

  it("appends extra args last so they can override the allowlist", () => {
    expect(buildFlagArgs({ addDir: ["/a"] }, "--model opus")).toEqual([
      "--add-dir",
      "/a",
      "--model",
      "opus",
    ]);
  });

  it("returns an empty argv for empty input", () => {
    expect(buildFlagArgs(undefined)).toEqual([]);
    expect(buildFlagArgs({}, "")).toEqual([]);
  });
});

describe("tokenizeExtraArgs", () => {
  it("splits on whitespace", () => {
    expect(tokenizeExtraArgs("--bare --agent reviewer")).toEqual(["--bare", "--agent", "reviewer"]);
  });

  it("keeps quoted values together", () => {
    expect(tokenizeExtraArgs('--add-dir "/path with spaces"')).toEqual([
      "--add-dir",
      "/path with spaces",
    ]);
    expect(tokenizeExtraArgs("--x 'a b'")).toEqual(["--x", "a b"]);
  });

  it("preserves an empty quoted token", () => {
    expect(tokenizeExtraArgs('--x ""')).toEqual(["--x", ""]);
  });

  it("collapses runs of whitespace", () => {
    expect(tokenizeExtraArgs("  --a   --b  ")).toEqual(["--a", "--b"]);
  });

  it("returns [] for empty or undefined", () => {
    expect(tokenizeExtraArgs(undefined)).toEqual([]);
    expect(tokenizeExtraArgs("   ")).toEqual([]);
  });
});

describe("buildSettingsJson", () => {
  // Probe-verified on Claude Code v2.1.218: without this key a bypass-mode
  // session stalls on the "Bypass Permissions mode" menu and never boots.
  it("adds skipDangerousModePermissionPrompt for bypass modes", () => {
    for (const mode of ["bypassPermissions", "dontAsk"] as const) {
      expect(JSON.parse(buildSettingsJson(mode))).toEqual({
        spinnerTipsEnabled: false,
        skipDangerousModePermissionPrompt: true,
      });
    }
  });

  it("leaves the blob untouched for non-bypass modes", () => {
    for (const mode of ["acceptEdits", "manual", "plan", "auto"] as const) {
      expect(JSON.parse(buildSettingsJson(mode))).toEqual({ spinnerTipsEnabled: false });
    }
  });
});

describe("permission modes", () => {
  it("accepts all six CLI values", () => {
    for (const mode of ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]) {
      expect(isPermissionMode(mode)).toBe(true);
    }
    expect(isPermissionMode("nonsense")).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
  });

  // Risk is value-dependent for permissionMode only — clients use this to decide
  // whether to demand confirmation before applying a change.
  it("rates only the bypass modes dangerous", () => {
    expect(flagValueRisk("permissionMode", "bypassPermissions")).toBe("dangerous");
    expect(flagValueRisk("permissionMode", "dontAsk")).toBe("dangerous");
    expect(flagValueRisk("permissionMode", "acceptEdits")).toBe("low");
    expect(flagValueRisk("addDir", ["/a"])).toBe("elevated");
    expect(flagValueRisk("unknownFlag", "x")).toBe("low");
  });
});

describe("effort levels", () => {
  it("accepts all five CLI values", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(isEffortLevel(level)).toBe(true);
    }
    expect(isEffortLevel("turbo")).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
  });
});

// The registry is shipped to mobile over GET /api/config/claude-flags and its
// settings form is rendered generically from it — so these two entries ARE the
// server-default model/effort control surface. Losing them silently removes the
// UI rather than breaking it.
describe("model/effort registry entries", () => {
  it("exposes model as a free-text string flag", () => {
    expect(CLAUDE_FLAGS.find((f) => f.id === "model")).toEqual({
      id: "model",
      flag: "--model",
      valueType: "string",
      risk: "low",
    });
  });

  it("exposes effort as an enum flag carrying the level list", () => {
    const def = CLAUDE_FLAGS.find((f) => f.id === "effort");
    expect(def).toMatchObject({ id: "effort", flag: "--effort", valueType: "enum" });
    expect(def?.enumValues).toEqual(EFFORT_LEVELS);
  });
});

describe("effectivePermissionMode", () => {
  it("prefers claudeFlags over the --default-permission-mode fallback", () => {
    // The precedence that matters: spawnFlagOverrides() reads permissionMode
    // from claudeFlags, so a boot warning consulting only the fallback would
    // stay silent while a claude_flags: bypass is what actually reaches argv.
    expect(effectivePermissionMode({ permissionMode: "bypassPermissions" }, "acceptEdits")).toBe(
      "bypassPermissions",
    );
  });

  it("falls back when claudeFlags carries no permissionMode", () => {
    expect(effectivePermissionMode({ model: "opus" }, "dontAsk")).toBe("dontAsk");
    expect(effectivePermissionMode(undefined, "manual")).toBe("manual");
  });

  it("returns undefined when neither source names a valid mode", () => {
    expect(effectivePermissionMode(undefined, undefined)).toBeUndefined();
    expect(effectivePermissionMode(undefined, "nonsense")).toBeUndefined();
    expect(effectivePermissionMode({ permissionMode: "nonsense" }, undefined)).toBeUndefined();
  });
});
