import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateNotes } from "@semantic-release/release-notes-generator";

const REPO_ROOT = join(__dirname, "..");

function releaseNotesConfig() {
  const releaseConfig = JSON.parse(readFileSync(join(REPO_ROOT, ".releaserc.json"), "utf8")) as {
    plugins?: Array<string | [string, Record<string, unknown>]>;
  };
  const entry = releaseConfig.plugins?.find(
    (plugin) =>
      plugin === "@semantic-release/release-notes-generator" ||
      (Array.isArray(plugin) && plugin[0] === "@semantic-release/release-notes-generator"),
  );
  if (!entry) {
    throw new Error(".releaserc.json has no @semantic-release/release-notes-generator plugin");
  }
  return Array.isArray(entry) ? (entry[1] ?? {}) : {};
}

it("renders a release-worthy commit in the generated notes", async () => {
  const hash = "fd89defcd2460b77acad6ee8c0cc068bffb66efd";
  const notes = await generateNotes(releaseNotesConfig(), {
    cwd: REPO_ROOT,
    commits: [
      {
        hash,
        message: "feat(e2ee): seal WebSocket transport per device context",
      },
    ],
    lastRelease: {
      version: "1.71.0",
      gitTag: "v1.71.0",
      gitHead: "f95150cc03c33a165ba221f694206a5b11636001",
    },
    nextRelease: {
      version: "1.72.0",
      gitTag: "v1.72.0",
      gitHead: hash,
      type: "minor",
    },
    options: {
      repositoryUrl: "https://github.com/RonenMars/threadbase-streamer.git",
    },
    logger: {
      log: () => {},
      error: () => {},
    },
  });

  expect(notes).toContain("### Features");
  expect(notes).toContain("seal WebSocket transport per device context");
});
