import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import type { ServerResponse } from "http";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionHandlers, type SessionHandlersDeps } from "../src/api/handlers/sessions.handlers";
import { listClaudeSkills } from "../src/claude-skills";

let root: string;
let home: string;
let project: string;

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skill(dir: string, frontmatter: string, body = "Body\n") {
  put(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-skills-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const names = () => listClaudeSkills({ home, projectPath: project }).map((s) => s.name);

describe("listClaudeSkills", () => {
  it("names a skill by its folder, as Claude Code does, whatever its frontmatter name", () => {
    skill(
      join(home, ".claude/skills/tdd-folder"),
      "name: tdd\ndescription: Test-driven development.\nargument-hint: <feature>",
    );
    skill(join(project, ".claude/skills/deploy"), "description: Ship it.");

    expect(listClaudeSkills({ home, projectPath: project })).toEqual([
      { name: "deploy", description: "Ship it.", source: "project" },
      {
        name: "tdd-folder",
        description: "Test-driven development.",
        argumentHint: "<feature>",
        source: "user",
      },
    ]);
  });

  it("names commands by relative path with ':' and falls back to the first body line", () => {
    put(join(project, ".claude/commands/frontend/build.md"), "\n# Build the frontend\n\nSteps...");
    put(join(home, ".claude/commands/standup.md"), "---\ndescription: Daily standup\n---\nText");

    const skills = listClaudeSkills({ home, projectPath: project });
    expect(skills).toContainEqual({
      name: "frontend:build",
      description: "Build the frontend",
      source: "project",
    });
    expect(skills).toContainEqual({
      name: "standup",
      description: "Daily standup",
      source: "user",
    });
  });

  it("lists skills and commands of enabled plugins only, namespaced by plugin", () => {
    const on = join(root, "cache/market/review-kit/1.0.0");
    const off = join(root, "cache/market/other/2.0.0");
    skill(join(on, "skills/lint"), "name: lint\ndescription: Lint it.");
    put(join(on, "commands/fix.md"), "---\ndescription: Fix it.\n---\n");
    skill(join(off, "skills/hidden"), "description: Never listed.");
    put(
      join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "review-kit@market": [{ scope: "user", installPath: on }],
          "other@market": [{ scope: "user", installPath: off }],
        },
      }),
    );
    put(
      join(home, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { "review-kit@market": true, "other@market": false } }),
    );

    expect(names()).toEqual(["review-kit:fix", "review-kit:lint"]);
    expect(listClaudeSkills({ home, projectPath: project })[0].source).toBe("plugin");
  });

  it("lets the project settings enable a plugin", () => {
    const path = join(root, "cache/market/kit/1.0.0");
    skill(join(path, "skills/a"), "description: A.");
    put(
      join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ plugins: { "kit@market": [{ installPath: path }] } }),
    );
    put(
      join(project, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { "kit@market": true } }),
    );

    expect(names()).toEqual(["kit:a"]);
  });

  it("hides skills turned off in skillOverrides, the project file winning over the personal one", () => {
    for (const n of ["gone", "back", "model-off", "short"])
      skill(join(home, `.claude/skills/${n}`), "description: d");
    put(
      join(home, ".claude/settings.json"),
      JSON.stringify({
        skillOverrides: {
          gone: "off",
          back: "off",
          "model-off": "user-invocable-only",
          short: "name-only",
        },
      }),
    );
    put(
      join(project, ".claude/settings.json"),
      JSON.stringify({ skillOverrides: { back: "user-invocable-only" } }),
    );

    expect(names()).toEqual(["back", "model-off", "short"]);
  });

  it("hides skills that are not user-invocable", () => {
    skill(join(home, ".claude/skills/bg"), "description: Background only.\nuser-invocable: false");
    skill(join(home, ".claude/skills/fg"), "description: Visible.");

    expect(names()).toEqual(["fg"]);
  });

  it("follows symlinked skill directories", () => {
    const real = join(root, "dotfiles/skills/linked");
    skill(real, "description: Linked skill.");
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    symlinkSync(real, join(home, ".claude/skills/linked"));

    expect(names()).toEqual(["linked"]);
  });

  it("falls back to the directory name when the frontmatter is not valid YAML", () => {
    skill(join(home, ".claude/skills/broken"), "description: [unclosed");
    skill(join(home, ".claude/skills/ok"), "description: Fine.");

    const skills = listClaudeSkills({ home, projectPath: project });
    expect(skills).toEqual([
      { name: "broken", description: "", source: "user" },
      { name: "ok", description: "Fine.", source: "user" },
    ]);
  });

  it("returns an empty list when nothing exists", () => {
    expect(listClaudeSkills({ home, projectPath: join(root, "missing") })).toEqual([]);
  });

  // Claude Code docs: personal overrides project, and a skill beats a command of the same name.
  it("keeps the user skill over the project one and the skill over a command", () => {
    skill(join(home, ".claude/skills/review"), "description: User review.");
    skill(join(project, ".claude/skills/review"), "description: Project review.");
    put(join(home, ".claude/commands/plan.md"), "---\ndescription: Command plan.\n---\n");
    skill(join(project, ".claude/skills/plan"), "description: Skill plan.");

    const skills = listClaudeSkills({ home, projectPath: project });
    expect(skills.find((s) => s.name === "review")?.description).toBe("User review.");
    expect(skills.find((s) => s.name === "plan")?.description).toBe("Skill plan.");
    expect(names()).toEqual(["plan", "review"]);
  });
});

function response(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0;
  let payload = "";
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    setHeader: () => res,
    end: (chunk?: string) => {
      payload = chunk ?? "";
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => (payload ? JSON.parse(payload) : undefined),
  };
}

describe("SessionHandlers.handleGetSkills", () => {
  const sessions: Record<string, { provider?: string; projectPath: string }> = {};
  const handlers = new SessionHandlers({
    sessionStore: { get: (id: string) => sessions[id] },
    ptyAttachedIds: () => new Set<string>(),
  } as unknown as SessionHandlersDeps);
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = home;
    // os.homedir() reads USERPROFILE on Windows and ignores HOME.
    savedUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = home;
    sessions.claude = { provider: "claude-code", projectPath: project };
    sessions.legacy = { projectPath: project };
    sessions.codex = { provider: "codex-cli", projectPath: project };
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  it("answers 404 for an unknown session", async () => {
    const r = response();
    await handlers.handleGetSkills("nope", r.res);
    expect(r.status()).toBe(404);
  });

  it("answers 501 UNSUPPORTED_PROVIDER for a non-Claude session", async () => {
    const r = response();
    await handlers.handleGetSkills("codex", r.res);
    expect(r.status()).toBe(501);
    expect(r.body()).toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
  });

  it("lists the session's skills from HOME and its project", async () => {
    skill(join(home, ".claude/skills/tdd"), "description: TDD.");
    skill(join(project, ".claude/skills/ship"), "description: Ship.");
    for (const id of ["claude", "legacy"]) {
      const r = response();
      await handlers.handleGetSkills(id, r.res);
      expect(r.status()).toBe(200);
      expect(r.body()).toEqual({
        skills: [
          { name: "ship", description: "Ship.", source: "project" },
          { name: "tdd", description: "TDD.", source: "user" },
        ],
      });
    }
  });
});
