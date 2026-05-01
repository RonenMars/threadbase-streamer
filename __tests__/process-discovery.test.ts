import { discoverClaudeProcesses } from "../src/process-discovery";

describe("process-discovery", () => {
  it("returns an array (may be empty if no claude processes running)", async () => {
    const result = await discoverClaudeProcesses();
    expect(Array.isArray(result)).toBe(true);
  });

  it("each discovered process has required fields", async () => {
    const results = await discoverClaudeProcesses();
    for (const proc of results) {
      expect(proc).toHaveProperty("pid");
      expect(typeof proc.pid).toBe("number");
      expect(proc).toHaveProperty("projectPath");
      expect(proc).toHaveProperty("projectName");
      expect(proc).toHaveProperty("branch");
      expect(proc).toHaveProperty("startedAt");
      expect(proc.startedAt).toBeInstanceOf(Date);
    }
  });
});
