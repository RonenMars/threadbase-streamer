import { describe, expect, it } from "vitest";
import { getSupervisor, type Supervisor } from "../../src/lifecycle/platform";

describe("getSupervisor()", () => {
  it("returns an object that satisfies the Supervisor interface", () => {
    const sup: Supervisor = getSupervisor();
    expect(typeof sup.isAgentLoaded).toBe("function");
    expect(typeof sup.bootoutAgent).toBe("function");
    expect(typeof sup.bootstrapAgent).toBe("function");
    expect(typeof sup.kickstartAgent).toBe("function");
    expect(typeof sup.getAgentPid).toBe("function");
  });

  it.runIf(process.platform === "darwin")("picks launchd on darwin", async () => {
    const sup = getSupervisor();
    const launchd = await import("../../src/lifecycle/launchd");
    expect(sup.isAgentLoaded).toBe(launchd.isAgentLoaded);
  });

  it.runIf(process.platform === "win32")("picks task-scheduler on win32", async () => {
    const sup = getSupervisor();
    const ts = await import("../../src/lifecycle/task-scheduler");
    expect(sup.isAgentLoaded).toBe(ts.isAgentLoaded);
  });

  it.runIf(process.platform !== "darwin" && process.platform !== "win32")(
    "throws on unsupported platforms",
    () => {
      expect(() => getSupervisor()).toThrow(/unsupported/i);
    },
  );
});
