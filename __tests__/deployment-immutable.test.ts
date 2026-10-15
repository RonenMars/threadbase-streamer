import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackTarball } from "../src/updater/unpack";

it("refuses to overwrite an existing release before reading the tarball", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-immutable-"));
  try {
    writeFileSync(join(dir, "cli.cjs"), "running build");
    await expect(unpackTarball({ destDir: dir, tarballPath: "missing.tgz" })).rejects.toThrow(
      "already exists",
    );
    expect(readFileSync(join(dir, "cli.cjs"), "utf8")).toBe("running build");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("removes only its own incomplete staging directory after extraction fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-extract-"));
  const dest = join(dir, "new-release");
  try {
    await expect(
      unpackTarball({ destDir: dest, tarballPath: join(dir, "missing.tgz") }),
    ).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
