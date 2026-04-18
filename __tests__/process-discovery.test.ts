import { discoverClaudeProcesses } from "../src/process-discovery";

describe("process-discovery", () => {
  it("returns an array (may be empty if no claude processes running)", () => {
    const result = discoverClaudeProcesses();
    expect(Array.isArray(result)).toBe(true);
  });

  it("each discovered process has required fields", () => {
    const results = discoverClaudeProcesses();
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
