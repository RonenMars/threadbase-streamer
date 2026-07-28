import {
  FEATURE_FLAGS,
  findFeatureFlag,
  nonDefaultFeatureFlags,
  parseBooleanEnv,
  parseFeatureFlagArgs,
  resolveFeatureFlags,
  validateFeatureFlagValues,
} from "../src/feature-flags";

// The flag under test. Reading it from the registry rather than hardcoding the
// string keeps these tests honest if the first entry is ever renamed.
const FLAG = FEATURE_FLAGS[0];

describe("feature flags registry", () => {
  it("declares unique ids and env vars", () => {
    const ids = FEATURE_FLAGS.map((f) => f.id);
    const envs = FEATURE_FLAGS.map((f) => f.env);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("names every env var THREADBASE_FEATURE_*", () => {
    for (const f of FEATURE_FLAGS) {
      expect(f.env).toMatch(/^THREADBASE_FEATURE_[A-Z0-9_]+$/);
    }
  });

  // Pinned literally: this name is a public contract (docs, env.example, and
  // any deployment that already exports it), so a rename must fail loudly here.
  it("keeps codexSystemPrompt's env var name stable", () => {
    expect(findFeatureFlag("codexSystemPrompt")?.env).toBe(
      "THREADBASE_FEATURE_CODEX_SYSTEM_PROMPT",
    );
  });

  it("finds a known flag and rejects an unknown one", () => {
    expect(findFeatureFlag(FLAG.id)?.id).toBe(FLAG.id);
    expect(findFeatureFlag("nopeNotAFlag")).toBeUndefined();
  });
});

describe("parseBooleanEnv", () => {
  it("returns undefined for an unset var so a lower rung can win", () => {
    expect(parseBooleanEnv(undefined)).toBeUndefined();
  });

  it.each(["1", "true", "TRUE", "yes", "on", " true "])("reads %s as true", (raw) => {
    expect(parseBooleanEnv(raw)).toBe(true);
  });

  it.each(["0", "false", "FALSE", "no", "off", "", "  "])("reads %s as false", (raw) => {
    expect(parseBooleanEnv(raw)).toBe(false);
  });
});

describe("validateFeatureFlagValues", () => {
  it("keeps a known id with a boolean value", () => {
    expect(validateFeatureFlagValues({ [FLAG.id]: true })).toEqual({ [FLAG.id]: true });
  });

  it("drops an unknown id but keeps valid siblings", () => {
    expect(validateFeatureFlagValues({ bogus: true, [FLAG.id]: true })).toEqual({
      [FLAG.id]: true,
    });
  });

  it("drops an ill-typed value rather than coercing it", () => {
    // "true" as a string means the writer misunderstood the format. Guessing at
    // intent is how a flag silently ends up on.
    expect(validateFeatureFlagValues({ [FLAG.id]: "true" })).toEqual({});
    expect(validateFeatureFlagValues({ [FLAG.id]: 1 })).toEqual({});
  });

  it.each([null, undefined, "string", 42, [1, 2]])("returns {} for non-object %s", (raw) => {
    expect(validateFeatureFlagValues(raw)).toEqual({});
  });
});

describe("parseFeatureFlagArgs", () => {
  it("parses id=true and id=false", () => {
    expect(parseFeatureFlagArgs([`${FLAG.id}=true`])).toEqual({
      values: { [FLAG.id]: true },
      errors: [],
    });
    expect(parseFeatureFlagArgs([`${FLAG.id}=false`])).toEqual({
      values: { [FLAG.id]: false },
      errors: [],
    });
  });

  it("treats a bare id as true", () => {
    expect(parseFeatureFlagArgs([FLAG.id]).values).toEqual({ [FLAG.id]: true });
  });

  it("returns an error for an unknown id rather than throwing", () => {
    const result = parseFeatureFlagArgs(["bogus=true"]);
    expect(result.values).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bogus");
  });

  it("returns a legible error naming true/false for a non-boolean value", () => {
    const result = parseFeatureFlagArgs([`${FLAG.id}=high`]);
    expect(result.values).toEqual({});
    expect(result.errors[0]).toContain("expected true/false");
  });

  it("collects every error across entries", () => {
    expect(parseFeatureFlagArgs(["bogus=true", `${FLAG.id}=maybe`]).errors).toHaveLength(2);
  });

  it("lets a later entry win when an id repeats", () => {
    expect(parseFeatureFlagArgs([`${FLAG.id}=true`, `${FLAG.id}=false`]).values).toEqual({
      [FLAG.id]: false,
    });
  });
});

describe("resolveFeatureFlags precedence", () => {
  // env is passed explicitly everywhere below so these never read the ambient
  // process.env and can't be perturbed by the developer's shell.
  const NO_ENV = {} as NodeJS.ProcessEnv;

  it("falls back to the registry default when nothing speaks", () => {
    expect(resolveFeatureFlags({ env: NO_ENV })[FLAG.id]).toBe(FLAG.default);
  });

  it("uses yaml when only yaml speaks", () => {
    expect(resolveFeatureFlags({ yaml: { [FLAG.id]: true }, env: NO_ENV })[FLAG.id]).toBe(true);
  });

  it("prefers CLI over yaml", () => {
    const values = resolveFeatureFlags({
      yaml: { [FLAG.id]: false },
      cli: { [FLAG.id]: true },
      env: NO_ENV,
    });
    expect(values[FLAG.id]).toBe(true);
  });

  it("prefers env over both CLI and yaml", () => {
    const values = resolveFeatureFlags({
      yaml: { [FLAG.id]: false },
      cli: { [FLAG.id]: false },
      env: { [FLAG.env]: "1" } as NodeJS.ProcessEnv,
    });
    expect(values[FLAG.id]).toBe(true);
  });

  it("lets env force a flag OFF over a true from CLI and yaml", () => {
    // The direction that matters operationally: killing a flag on a supervised
    // instance whose argv and yaml you can't easily change.
    const values = resolveFeatureFlags({
      yaml: { [FLAG.id]: true },
      cli: { [FLAG.id]: true },
      env: { [FLAG.env]: "0" } as NodeJS.ProcessEnv,
    });
    expect(values[FLAG.id]).toBe(false);
  });

  it("returns a total map — every registry id present", () => {
    const values = resolveFeatureFlags({ env: NO_ENV });
    expect(Object.keys(values).sort()).toEqual(FEATURE_FLAGS.map((f) => f.id).sort());
    for (const f of FEATURE_FLAGS) {
      expect(typeof values[f.id]).toBe("boolean");
    }
  });

  it("ignores an unknown id supplied by a caller", () => {
    const values = resolveFeatureFlags({ yaml: { bogus: true }, env: NO_ENV });
    expect(values).not.toHaveProperty("bogus");
  });

  it("works with no arguments at all", () => {
    expect(Object.keys(resolveFeatureFlags())).toHaveLength(FEATURE_FLAGS.length);
  });
});

describe("nonDefaultFeatureFlags", () => {
  it("is empty when everything sits at its default", () => {
    expect(nonDefaultFeatureFlags(resolveFeatureFlags({ env: {} as NodeJS.ProcessEnv }))).toEqual(
      [],
    );
  });

  it("names a flag flipped away from its default", () => {
    const values = resolveFeatureFlags({
      yaml: { [FLAG.id]: !FLAG.default },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(nonDefaultFeatureFlags(values)).toEqual([FLAG.id]);
  });
});
