import { handoffArgv } from "../src/handoff/command";

const base = { projectPath: "/work/app", additionalPaths: ["/work/lib"] };

describe("handoffArgv", () => {
  it("claude: resume + model/effort + allowlisted flags, no streamer-only flags", () => {
    const argv = handoffArgv(
      {
        ...base,
        additionalPaths: ["/work/lib", "/work/own"],
        provider: "claude-code",
        model: "opus",
        effort: "high",
      },
      "conv-1",
      { addDir: ["/work/shared", "/work/lib"], permissionMode: "plan" } as never,
    );
    expect(argv.slice(0, 6)).toEqual(["--resume", "conv-1", "--model", "opus", "--effort", "high"]);
    expect(argv).not.toContain("--settings");
    expect(argv).not.toContain("--permission-mode");
    // Server-wide dirs plus the session's own, each once.
    expect(argv.filter((a) => a === "/work/lib")).toHaveLength(1);
    expect(argv).toContain("/work/shared");
    expect(argv).toContain("/work/own");
  });

  it("claude: an unknown provider is treated as Claude", () => {
    expect(handoffArgv({ projectPath: "/p" }, "id", undefined)).toEqual(["--resume", "id"]);
  });

  it("codex: resume by the bound id, one --add-dir per dir, no --no-alt-screen", () => {
    expect(handoffArgv({ ...base, provider: "codex-cli" }, "rollout-9", undefined)).toEqual([
      "resume",
      "rollout-9",
      "--cd",
      "/work/app",
      "--add-dir",
      "/work/lib",
    ]);
  });

  it("cursor and copilot", () => {
    expect(handoffArgv({ ...base, provider: "cursor" }, "c1", undefined)).toEqual([
      "--workspace",
      "/work/app",
      "--trust",
      "--resume=c1",
    ]);
    expect(handoffArgv({ ...base, provider: "copilot", model: "gpt-5" }, "k1", undefined)).toEqual([
      "-C",
      "/work/app",
      "--resume=k1",
      "--model",
      "gpt-5",
    ]);
  });
});
