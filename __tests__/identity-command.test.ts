import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatIdentityBanner, runIdentity } from "../cli/identity";
import { serverIdentityFingerprint, serverIdentityPublicKey } from "../src/server-identity";

/**
 * `tb-streamer identity` (design.md §2.2). Its whole job is showing the
 * fingerprint, so the failure path matters as much as the success path: a
 * corrupt key file must read as a plain, actionable message and a non-zero
 * exit, never a stack trace or a silently empty banner.
 */
describe("runIdentity", () => {
  it("prints the fingerprint banner and returns 0 on success", () => {
    const log = { info: vi.fn(), error: vi.fn() };

    const code = runIdentity({
      log,
      fingerprint: () => "aaaa bbbb cccc dddd eeee ffff 0000 1111",
      keyPath: () => "/tmp/fake/server-identity.key",
    });

    expect(code).toBe(0);
    expect(log.info).toHaveBeenCalledWith(
      formatIdentityBanner(
        "aaaa bbbb cccc dddd eeee ffff 0000 1111",
        "/tmp/fake/server-identity.key",
      ),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("banner carries the key path, the fingerprint, and the phone-comparison line", () => {
    const banner = formatIdentityBanner(
      "aaaa bbbb cccc dddd eeee ffff 0000 1111",
      "/tmp/fake/server-identity.key",
    );

    expect(banner).toContain("/tmp/fake/server-identity.key");
    expect(banner).toContain("aaaa bbbb cccc dddd eeee ffff 0000 1111");
    expect(banner).toContain("Compare this with the identity code your phone shows");
  });

  // Deliberately broken and watched fail before the try/catch existed: with
  // `fingerprint` allowed to throw uncaught, this test failed with the raw
  // Error propagating out of runIdentity instead of a return value, and
  // log.error was never called. Restoring the try/catch fixed both.
  it("reports an unreadable key plainly and exits 1, without printing a banner", () => {
    const log = { info: vi.fn(), error: vi.fn() };

    const code = runIdentity({
      log,
      fingerprint: () => {
        throw new Error("Server identity key at /x could not be read.");
      },
      keyPath: () => "/x",
    });

    expect(code).toBe(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Server identity key at /x could not be read."),
    );
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("/x"));
  });

  // End-to-end wiring check: without a `fingerprint` override, runIdentity
  // must reach the real on-disk key via currentServerIdentityFingerprint(),
  // not silently no-op. Isolated with THREADBASE_CONFIG_DIR the same way
  // server-identity.test.ts is, so this never touches the real
  // ~/.threadbase/keys/server-identity.key.
  it("defaults to the real on-disk key when no override is given", () => {
    const saved = process.env.THREADBASE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "threadbase-identity-cli-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;

    try {
      const log = { info: vi.fn(), error: vi.fn() };
      const code = runIdentity({ log });

      const expected = serverIdentityFingerprint(serverIdentityPublicKey());
      expect(code).toBe(0);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(expected));
    } finally {
      if (saved === undefined) delete process.env.THREADBASE_CONFIG_DIR;
      else process.env.THREADBASE_CONFIG_DIR = saved;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
