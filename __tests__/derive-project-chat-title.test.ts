import { describe, expect, it } from "vitest";
import { deriveProjectChatTitle } from "../src/services/projectChats/deriveProjectChatTitle";

describe("deriveProjectChatTitle", () => {
  it("returns the explicit title when present", () => {
    expect(
      deriveProjectChatTitle({
        title: "Fix the foo bug",
        projectName: "me/dev/proj",
        projectPath: "/Users/me/dev/proj",
        id: "abcd1234",
      }),
    ).toBe("Fix the foo bug");
  });

  it("trims whitespace-only titles before falling through", () => {
    expect(
      deriveProjectChatTitle({
        title: "   ",
        projectName: "me/dev/proj",
        projectPath: null,
        id: "abcd1234",
      }),
    ).toBe("me/dev/proj");
  });

  it("falls back to projectName when title is missing", () => {
    expect(
      deriveProjectChatTitle({
        title: null,
        projectName: "me/dev/proj",
        projectPath: "/Users/me/dev/proj",
        id: "abcd1234",
      }),
    ).toBe("me/dev/proj");
  });

  it("falls back to the last two path segments when projectName is missing", () => {
    expect(
      deriveProjectChatTitle({
        title: null,
        projectName: null,
        projectPath: "/Users/me/dev/proj",
        id: "abcd1234",
      }),
    ).toBe("dev/proj");
  });

  it("falls back to a short-id Untitled when nothing is present", () => {
    expect(
      deriveProjectChatTitle({
        title: null,
        projectName: null,
        projectPath: null,
        id: "abcd1234-5678-...",
      }),
    ).toBe("Untitled · abcd1234");
  });

  it("never returns an empty string", () => {
    const t = deriveProjectChatTitle({
      title: undefined,
      projectName: undefined,
      projectPath: undefined,
      id: "x",
    });
    expect(t.length).toBeGreaterThan(0);
  });
});
