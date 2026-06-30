import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDevSessionMarker, devLogPath } from "../src/devLog";

describe("dev session log", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dev-log-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("appends a timestamped separator instead of truncating", () => {
    appendDevSessionMarker();
    appendDevSessionMarker();

    const content = readFileSync(devLogPath(), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^=== dev session started \d{4}-\d{2}-\d{2}T.*Z ===$/);
    }
  });

  it("creates the logs directory if missing", () => {
    expect(existsSync(join(dir, "logs"))).toBe(false);
    appendDevSessionMarker();
    expect(existsSync(devLogPath())).toBe(true);
  });
});
