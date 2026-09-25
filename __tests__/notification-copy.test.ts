import { attentionTitle, describeGate } from "../src/services/push/notificationCopy";

describe("attentionTitle", () => {
  it("leaves a default branch out", () => {
    expect(attentionTitle("turn_done", "my-app", "main")).toBe("✅ my-app");
    expect(attentionTitle("turn_done", "my-app", "master")).toBe("✅ my-app");
    expect(attentionTitle("turn_done", "my-app", "")).toBe("✅ my-app");
  });

  it("names any other branch", () => {
    expect(attentionTitle("permission", "my-app", "fix/login")).toBe("✋ my-app · fix/login");
  });

  it("shortens the branch to keep the title within 30 characters", () => {
    const title = attentionTitle("turn_done", "my-app", "feat/a-very-long-branch-name-indeed");
    expect(title).toBe("✅ my-app · feat/a-very-long-b…");
    expect(title.length).toBeLessThanOrEqual(30);
  });

  it("drops the branch rather than the project when there is no room", () => {
    expect(attentionTitle("turn_done", "an-unusually-long-project-name", "fix/x")).toBe(
      "✅ an-unusually-long-project-name",
    );
  });
});

describe("describeGate", () => {
  // Captured from a real Claude gate (detect-permission-gate.test.ts).
  const bashGate = {
    prompt: "Do you want to proceed?",
    detail: "Bash command\ngit push origin main\nPush the merge commit to origin/main",
  };

  it("reads a Claude Bash gate as a command", () => {
    expect(describeGate(bashGate)).toEqual({ kind: "permission", facts: { action: "command" } });
  });

  it("reads Codex's command approval as a command", () => {
    expect(describeGate({ prompt: "Codex requests command approval", detail: "$ ls" })).toEqual({
      kind: "permission",
      facts: { action: "command" },
    });
  });

  it("reads Claude's edit prompt as a file edit", () => {
    expect(describeGate({ prompt: "Do you want to make this edit?" })).toEqual({
      kind: "permission",
      facts: { action: "edit" },
    });
  });

  it("says nothing about a gate it does not recognise", () => {
    expect(describeGate({ prompt: "Do you trust the contents of this directory?" })).toEqual({
      kind: "permission",
      facts: {},
    });
    expect(describeGate({})).toEqual({ kind: "permission", facts: {} });
  });

  it("turns a Codex usage-limit screen into a limit, with its reset time", () => {
    expect(
      describeGate({
        prompt: "■ You've hit your usage limit. Upgrade to Pro.",
        detail: "or try again at 3:45 PM.",
      }),
    ).toEqual({ kind: "limited", facts: { resetsAt: "3:45 PM" } });
  });

  it("keeps a reset line with no time in it out of the copy", () => {
    expect(
      describeGate({
        prompt: "You have hit your usage limit",
        detail: "try again at a later point",
      }),
    ).toEqual({ kind: "limited", facts: {} });
  });

  it("never carries the command into what the copy sees", () => {
    // Positive control: the gate does hold the command.
    expect(JSON.stringify(bashGate)).toContain("git push origin main");
    expect(JSON.stringify(describeGate(bashGate))).not.toContain("git push");
  });
});
