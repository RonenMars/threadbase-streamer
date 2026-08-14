import { readdirSync, readFileSync } from "fs";
import { join, sep } from "path";
import {
  describeFeatureFlags,
  FEATURE_FLAGS,
  type FeatureFlagValues,
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

  it("keeps sessionRehydration's env var name stable, and its default ON", () => {
    const flag = findFeatureFlag("sessionRehydration");
    expect(flag?.env).toBe("THREADBASE_FEATURE_SESSION_REHYDRATION");
    // Shipped on: it changes what GET /api/sessions contains, so it exists as a
    // kill switch, not as an opt-in.
    expect(flag?.default).toBe(true);
  });

  it("keeps ptyHost's env var name stable, and its default OFF", () => {
    const flag = findFeatureFlag("ptyHost");
    expect(flag?.env).toBe("THREADBASE_FEATURE_PTY_HOST");
    expect(flag?.default).toBe(false);
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
    expect(resolveFeatureFlags({ env: NO_ENV }).values[FLAG.id]).toBe(FLAG.default);
  });

  it("uses yaml when only yaml speaks", () => {
    expect(resolveFeatureFlags({ yaml: { [FLAG.id]: true }, env: NO_ENV }).values[FLAG.id]).toBe(
      true,
    );
  });

  it("prefers CLI over yaml", () => {
    const { values } = resolveFeatureFlags({
      yaml: { [FLAG.id]: false },
      cli: { [FLAG.id]: true },
      env: NO_ENV,
    });
    expect(values[FLAG.id]).toBe(true);
  });

  it("prefers env over both CLI and yaml", () => {
    const { values } = resolveFeatureFlags({
      yaml: { [FLAG.id]: false },
      cli: { [FLAG.id]: false },
      env: { [FLAG.env]: "1" } as NodeJS.ProcessEnv,
    });
    expect(values[FLAG.id]).toBe(true);
  });

  it("lets env force a flag OFF over a true from CLI and yaml", () => {
    // The direction that matters operationally: killing a flag on a supervised
    // instance whose argv and yaml you can't easily change.
    const { values } = resolveFeatureFlags({
      yaml: { [FLAG.id]: true },
      cli: { [FLAG.id]: true },
      env: { [FLAG.env]: "0" } as NodeJS.ProcessEnv,
    });
    expect(values[FLAG.id]).toBe(false);
  });

  // A default-ON flag exercises the chain in the opposite direction from FLAG,
  // where every rung has to be able to turn something OFF.
  it("resolves sessionRehydration through the whole chain, in both directions", () => {
    const on = findFeatureFlag("sessionRehydration");
    if (!on) throw new Error("sessionRehydration missing from the registry");

    expect(resolveFeatureFlags({ env: NO_ENV }).values[on.id]).toBe(true);
    expect(resolveFeatureFlags({ yaml: { [on.id]: false }, env: NO_ENV }).values[on.id]).toBe(
      false,
    );
    expect(
      resolveFeatureFlags({ yaml: { [on.id]: true }, cli: { [on.id]: false }, env: NO_ENV }).values[
        on.id
      ],
    ).toBe(false);
    expect(
      resolveFeatureFlags({
        yaml: { [on.id]: true },
        cli: { [on.id]: true },
        env: { [on.env]: "0" } as NodeJS.ProcessEnv,
      }).values[on.id],
    ).toBe(false);
  });

  it("resolves ptyHost through the whole chain, in both directions", () => {
    const off = findFeatureFlag("ptyHost");
    if (!off) throw new Error("ptyHost missing from the registry");

    expect(resolveFeatureFlags({ env: NO_ENV }).values[off.id]).toBe(false);
    expect(resolveFeatureFlags({ yaml: { [off.id]: true }, env: NO_ENV }).values[off.id]).toBe(
      true,
    );
    expect(
      resolveFeatureFlags({ yaml: { [off.id]: false }, cli: { [off.id]: true }, env: NO_ENV })
        .values[off.id],
    ).toBe(true);
    expect(
      resolveFeatureFlags({
        yaml: { [off.id]: true },
        cli: { [off.id]: true },
        env: { [off.env]: "0" } as NodeJS.ProcessEnv,
      }).values[off.id],
    ).toBe(false);
  });

  it("returns a total map — every registry id present", () => {
    const { values } = resolveFeatureFlags({ env: NO_ENV });
    expect(Object.keys(values).sort()).toEqual(FEATURE_FLAGS.map((f) => f.id).sort());
    for (const f of FEATURE_FLAGS) {
      expect(typeof values[f.id]).toBe("boolean");
    }
  });

  it("ignores an unknown id supplied by a caller", () => {
    // Cast: the parameter type now rejects this statically, which is the point
    // — but the runtime guard has to hold too, since yaml reaches it unvalidated.
    const { values } = resolveFeatureFlags({
      yaml: { bogus: true } as unknown as FeatureFlagValues,
      env: NO_ENV,
    });
    expect(values).not.toHaveProperty("bogus");
  });

  it("works with no arguments at all", () => {
    expect(Object.keys(resolveFeatureFlags().values)).toHaveLength(FEATURE_FLAGS.length);
  });
});

describe("resolveFeatureFlags provenance", () => {
  const NO_ENV = {} as NodeJS.ProcessEnv;

  it("reports every rung by name", () => {
    // One flag per rung, so a mix-up between them cannot pass by coincidence.
    const { sources } = resolveFeatureFlags({
      override: { codexSystemPrompt: true },
      env: { [findFeatureFlag("ptyHost")!.env]: "1" } as NodeJS.ProcessEnv,
      cli: { liveActivityPush: true },
      yaml: { sessionRehydration: false },
    });
    expect(sources.codexSystemPrompt).toBe("override");
    expect(sources.ptyHost).toBe("env");
    expect(sources.liveActivityPush).toBe("cli");
    expect(sources.sessionRehydration).toBe("yaml");
  });

  it("says default when nothing spoke", () => {
    const { sources } = resolveFeatureFlags({ env: NO_ENV });
    for (const f of FEATURE_FLAGS) expect(sources[f.id]).toBe("default");
  });

  // `false` is a real answer, not silence. If a rung's false were treated as
  // absent the source would name the wrong rung and the value would be wrong
  // too — the failure the tri-state parseBooleanEnv exists to prevent, one
  // layer up.
  it("treats an explicit false as having spoken", () => {
    const { values, sources } = resolveFeatureFlags({
      yaml: { sessionRehydration: false },
      env: NO_ENV,
    });
    expect(values.sessionRehydration).toBe(false);
    expect(sources.sessionRehydration).toBe("yaml");
  });

  it("lets the legacy override outrank env, the highest real source", () => {
    const codex = findFeatureFlag("codexSystemPrompt")!;
    const { values, sources } = resolveFeatureFlags({
      override: { codexSystemPrompt: false },
      env: { [codex.env]: "1" } as NodeJS.ProcessEnv,
    });
    expect(values.codexSystemPrompt).toBe(false);
    expect(sources.codexSystemPrompt).toBe("override");
  });

  it("returns a total sources map", () => {
    const { sources } = resolveFeatureFlags({ env: NO_ENV });
    expect(Object.keys(sources).sort()).toEqual(FEATURE_FLAGS.map((f) => f.id).sort());
  });
});

describe("describeFeatureFlags", () => {
  it("states value and source for every flag, not just the surprising ones", () => {
    const resolution = resolveFeatureFlags({
      yaml: { sessionRehydration: false },
      env: {} as NodeJS.ProcessEnv,
    });
    const line = describeFeatureFlags(resolution);

    // The regression this replaces: nonDefaultFeatureFlags() lists a disabled
    // default-ON flag, and the old message headed that list "Feature flags
    // active" — reporting sessionRehydration as active at the moment it was
    // turned off. The value in the line is what makes that unambiguous.
    expect(nonDefaultFeatureFlags(resolution.values)).toContain("sessionRehydration");
    expect(line).toContain("sessionRehydration=false(yaml)");

    for (const f of FEATURE_FLAGS) expect(line).toContain(`${f.id}=`);
  });
});

describe("nonDefaultFeatureFlags", () => {
  it("is empty when everything sits at its default", () => {
    expect(
      nonDefaultFeatureFlags(resolveFeatureFlags({ env: {} as NodeJS.ProcessEnv }).values),
    ).toEqual([]);
  });

  it("names a flag flipped away from its default", () => {
    const { values } = resolveFeatureFlags({
      yaml: { [FLAG.id]: !FLAG.default },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(nonDefaultFeatureFlags(values)).toEqual([FLAG.id]);
  });
});

// The failure this guards against is silent by construction: a flag can be
// declared, validated, persisted to server.yaml and served over HTTP while
// gating nothing at all. Every layer reports success, and the flag simply has
// no effect. CLAUDE.md records the same bug shipping in claude-flags, where a
// value round-tripped through the API and never reached argv.
describe("every registry flag is actually read", () => {
  it("finds a consumer for each id under src/ and cli/", () => {
    // cli/ is scanned too: `ptyHost` is read in cli/prod.ts to report host
    // liveness, and a src-only scan would call a cli-only flag unread.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(join(__dirname, "..", "src"));
    walk(join(__dirname, "..", "cli"));

    // The registry declares them; a mention anywhere else is a consumer.
    const haystack = files
      .filter((f) => !f.endsWith(`${sep}feature-flags.ts`))
      .map((f) => readFileSync(f, "utf-8"))
      .join("\n");

    const unread = FEATURE_FLAGS.filter((f) => !haystack.includes(f.id)).map((f) => f.id);
    expect(unread).toEqual([]);
  });
});
