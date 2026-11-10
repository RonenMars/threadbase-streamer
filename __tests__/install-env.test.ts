import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadInstallConfigIntoEnv } from "../src/config/install-env";

// Not a real key: the loader only checks that the file is non-empty.
const PEM = "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----";

describe("loadInstallConfigIntoEnv (shared by launchd, systemd and Task Scheduler)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "install-env-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("discovers the p8 and derives APNS_KEY_ID from the filename", () => {
    writeFileSync(join(dir, "AuthKey_ABC123DEFG.p8"), PEM);
    const env: NodeJS.ProcessEnv = {};
    loadInstallConfigIntoEnv(env, dir);
    expect(env.APNS_KEY).toBe(PEM);
    expect(env.APNS_KEY_ID).toBe("ABC123DEFG");
  });

  it("reads the install-dir .env", () => {
    writeFileSync(join(dir, ".env"), "APNS_TEAM_ID=TEAM000001\nAPNS_BUNDLE_ID=com.example.app\n");
    const env: NodeJS.ProcessEnv = {};
    loadInstallConfigIntoEnv(env, dir);
    expect(env.APNS_TEAM_ID).toBe("TEAM000001");
    expect(env.APNS_BUNDLE_ID).toBe("com.example.app");
  });

  it("lets a key id declared in .env beat the filename-derived one", () => {
    writeFileSync(join(dir, ".env"), "APNS_KEY_ID=ENVKEYID01\n");
    writeFileSync(join(dir, "AuthKey_ABC123DEFG.p8"), PEM);
    const env: NodeJS.ProcessEnv = {};
    loadInstallConfigIntoEnv(env, dir);
    expect(env.APNS_KEY_ID).toBe("ENVKEYID01");
    expect(env.APNS_KEY).toBe(PEM);
  });

  it("does not override variables that are already set", () => {
    writeFileSync(join(dir, ".env"), "APNS_TEAM_ID=FROMFILE\n");
    writeFileSync(join(dir, "AuthKey_ABC123DEFG.p8"), PEM);
    const env: NodeJS.ProcessEnv = {
      APNS_TEAM_ID: "EXPLICIT",
      APNS_KEY: "explicit-key",
      APNS_KEY_ID: "EXPLICITID",
    };
    loadInstallConfigIntoEnv(env, dir);
    expect(env).toEqual({
      APNS_TEAM_ID: "EXPLICIT",
      APNS_KEY: "explicit-key",
      APNS_KEY_ID: "EXPLICITID",
    });
  });

  it("is a silent no-op when the files, or the directory itself, are absent", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadInstallConfigIntoEnv(env, dir)).not.toThrow();
    expect(() => loadInstallConfigIntoEnv(env, join(dir, "missing"))).not.toThrow();
    expect(env).toEqual({});
  });

  it("defaults to THREADBASE_INSTALL_DIR for the directory", () => {
    writeFileSync(join(dir, ".env"), "APNS_HOST=api.example.com\n");
    vi.stubEnv("THREADBASE_INSTALL_DIR", dir);
    const env: NodeJS.ProcessEnv = {};
    try {
      loadInstallConfigIntoEnv(env);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(env.APNS_HOST).toBe("api.example.com");
  });
});

describe("CLI startup path", () => {
  const indexSrc = readFileSync(resolve(import.meta.dirname, "../cli/index.ts"), "utf8");

  it("side-effect module loads the install config into process.env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "install-env-boot-"));
    writeFileSync(join(dir, ".env"), "APNS_BUNDLE_ID=com.example.boot\n");
    vi.stubEnv("THREADBASE_INSTALL_DIR", dir);
    delete process.env.APNS_BUNDLE_ID;
    try {
      vi.resetModules();
      await import("../cli/load-install-env");
      expect(process.env.APNS_BUNDLE_ID).toBe("com.example.boot");
    } finally {
      delete process.env.APNS_BUNDLE_ID;
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The original defect (#481): systemd and Task Scheduler start `cli.js` in a
  // working directory that is not the install dir, so a `.env` or key looked up
  // from the cwd is never found. Every other test passes the dir in explicitly
  // or stubs THREADBASE_INSTALL_DIR, so none of them would notice the loader
  // reading from `process.cwd()` instead. Here the cwd holds a decoy `.env` and
  // no key; the real config is only in the install dir.
  it("reads the install dir, not the working directory, when they differ", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "install-env-real-"));
    const cwdDir = mkdtempSync(join(tmpdir(), "install-env-cwd-"));
    writeFileSync(join(installDir, ".env"), "APNS_BUNDLE_ID=com.example.install\n");
    writeFileSync(join(installDir, "AuthKey_ABC123DEFG.p8"), PEM);
    writeFileSync(join(cwdDir, ".env"), "APNS_BUNDLE_ID=com.example.cwd\nAPNS_TEAM_ID=FROMCWD\n");
    const startCwd = process.cwd();
    vi.stubEnv("THREADBASE_INSTALL_DIR", installDir);
    for (const k of ["APNS_BUNDLE_ID", "APNS_TEAM_ID", "APNS_KEY", "APNS_KEY_ID"]) {
      delete process.env[k];
    }
    try {
      process.chdir(cwdDir);
      vi.resetModules();
      await import("../cli/load-install-env");
      expect(process.env.APNS_BUNDLE_ID).toBe("com.example.install");
      expect(process.env.APNS_TEAM_ID).toBeUndefined();
      expect(process.env.APNS_KEY).toBe(PEM);
      expect(process.env.APNS_KEY_ID).toBe("ABC123DEFG");
    } finally {
      process.chdir(startCwd);
      for (const k of ["APNS_BUNDLE_ID", "APNS_TEAM_ID", "APNS_KEY", "APNS_KEY_ID"]) {
        delete process.env[k];
      }
      vi.unstubAllEnvs();
      rmSync(installDir, { recursive: true, force: true });
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  it("cli/index.ts imports it right after dotenv, before anything that could read APNS_*", () => {
    const imports = [...indexSrc.matchAll(/^import\s+(?:[^"']*from\s+)?["']([^"']+)["'];?$/gm)].map(
      (m) => m[1],
    );
    expect(imports.slice(0, 2)).toEqual(["dotenv/config", "./load-install-env"]);
  });
});
