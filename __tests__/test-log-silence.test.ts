import { applyInjectedLogLevel, resolveTestLogLevel } from "./setup/silence-logs";

describe("resolveTestLogLevel", () => {
  it("silences the default local path", () => {
    expect(resolveTestLogLevel({})).toBe("silent");
    expect(resolveTestLogLevel({ LOG_LEVEL: "" })).toBe("silent");
    expect(resolveTestLogLevel({ CI: "false" })).toBe("silent");
  });

  it("defaults CI to warn", () => {
    expect(resolveTestLogLevel({ CI: "true" })).toBe("warn");
    expect(resolveTestLogLevel({ CI: "1" })).toBe("warn");
    expect(resolveTestLogLevel({ CI: "true", LOG_LEVEL: "" })).toBe("warn");
  });

  it("keeps an explicit LOG_LEVEL", () => {
    expect(resolveTestLogLevel({ LOG_LEVEL: "error" })).toBe("error");
    expect(resolveTestLogLevel({ CI: "true", LOG_LEVEL: "error" })).toBe("error");
  });

  it("does not force a level when TEST_LOGS is on", () => {
    expect(resolveTestLogLevel({ TEST_LOGS: "1" })).toBeUndefined();
    expect(resolveTestLogLevel({ TEST_LOGS: "true", CI: "true", LOG_LEVEL: "debug" })).toBe(
      "debug",
    );
  });
});

describe("applyInjectedLogLevel", () => {
  it("clears an injected level on restore so child processes do not inherit it", () => {
    const env: { LOG_LEVEL?: string } = {};
    const restore = applyInjectedLogLevel(env, "silent");
    expect(env.LOG_LEVEL).toBe("silent");
    restore();
    expect(env.LOG_LEVEL).toBeUndefined();
  });

  it("leaves an explicit LOG_LEVEL in place", () => {
    const env: { LOG_LEVEL?: string } = { LOG_LEVEL: "error" };
    const restore = applyInjectedLogLevel(env, "error");
    restore();
    expect(env.LOG_LEVEL).toBe("error");
  });
});
