import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    cb: (err: Error | null, value: { stdout: string; stderr: string }) => void,
  ) => {
    Promise.resolve(execFileMock(cmd, args)).then(
      (v) => cb(null, v as { stdout: string; stderr: string }),
      (e) => cb(e as Error, { stdout: "", stderr: "" }),
    );
  },
}));

import { restartService, stopService } from "../src/updater/restart";

function spoofPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => {
    if (original) Object.defineProperty(process, "platform", original);
  };
}

describe("restartService", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    for (const v of ["LAUNCHD_LABEL", "THREADBASE_SYSTEMD_UNIT", "THREADBASE_TASK_NAME"]) {
      delete process.env[v];
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("on macOS calls launchctl kickstart -k gui/<uid>/<label>", async () => {
    const restore = spoofPlatform("darwin");
    try {
      // No brew service loaded (probe rejects) and no env override → the
      // kickstart targets the deploy.sh default label.
      execFileMock
        .mockRejectedValueOnce(new Error("Could not find service"))
        .mockResolvedValueOnce({ stdout: "ok", stderr: "" });
      const uid = process.getuid?.() ?? 0;
      const r = await restartService();
      expect(r.method).toBe("launchctl");
      expect(execFileMock).toHaveBeenLastCalledWith("launchctl", [
        "kickstart",
        "-k",
        `gui/${uid}/com.ronen.threadbase`,
      ]);
    } finally {
      restore();
    }
  });

  it("on Linux calls systemctl --user restart <unit>", async () => {
    const restore = spoofPlatform("linux");
    try {
      execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
      const r = await restartService();
      expect(r.method).toBe("systemctl");
      expect(execFileMock).toHaveBeenCalledWith("systemctl", [
        "--user",
        "restart",
        "threadbase.service",
      ]);
    } finally {
      restore();
    }
  });

  it("on Windows ends then starts the scheduled task", async () => {
    const restore = spoofPlatform("win32");
    try {
      execFileMock
        .mockResolvedValueOnce({ stdout: "ended", stderr: "" })
        .mockResolvedValueOnce({ stdout: "started", stderr: "" });
      const r = await restartService();
      expect(r.method).toBe("schtasks");
      expect(execFileMock).toHaveBeenNthCalledWith(1, "schtasks.exe", [
        "/End",
        "/TN",
        "Threadbase",
      ]);
      expect(execFileMock).toHaveBeenNthCalledWith(2, "schtasks.exe", [
        "/Run",
        "/TN",
        "Threadbase",
      ]);
    } finally {
      restore();
    }
  });

  it("honors LAUNCHD_LABEL env var on macOS without probing for the brew label", async () => {
    const restore = spoofPlatform("darwin");
    try {
      process.env.LAUNCHD_LABEL = "com.acme.custom";
      execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
      await restartService();
      // Env override wins outright — no `launchctl print` probe is issued.
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith("launchctl", [
        "kickstart",
        "-k",
        expect.stringMatching(/gui\/\d+\/com\.acme\.custom$/),
      ]);
    } finally {
      restore();
    }
  });

  it("on macOS restarts the brew label when the brew service is loaded", async () => {
    const restore = spoofPlatform("darwin");
    try {
      const uid = process.getuid?.() ?? 0;
      // First call is the brew-label probe (succeeds → loaded); second is the
      // kickstart against the resolved brew label.
      execFileMock
        .mockResolvedValueOnce({ stdout: "{ ... }", stderr: "" })
        .mockResolvedValueOnce({ stdout: "ok", stderr: "" });
      const r = await restartService();
      expect(r.method).toBe("launchctl");
      expect(execFileMock).toHaveBeenNthCalledWith(1, "launchctl", [
        "print",
        `gui/${uid}/homebrew.mxcl.tb-streamer`,
      ]);
      expect(execFileMock).toHaveBeenNthCalledWith(2, "launchctl", [
        "kickstart",
        "-k",
        `gui/${uid}/homebrew.mxcl.tb-streamer`,
      ]);
    } finally {
      restore();
    }
  });

  it("on macOS falls back to the deploy.sh label when the brew service is not loaded", async () => {
    const restore = spoofPlatform("darwin");
    try {
      const uid = process.getuid?.() ?? 0;
      // Probe rejects (not loaded) → fall through to the deploy.sh default.
      execFileMock
        .mockRejectedValueOnce(new Error("Could not find service"))
        .mockResolvedValueOnce({ stdout: "ok", stderr: "" });
      const r = await restartService();
      expect(r.method).toBe("launchctl");
      expect(execFileMock).toHaveBeenNthCalledWith(2, "launchctl", [
        "kickstart",
        "-k",
        `gui/${uid}/com.ronen.threadbase`,
      ]);
    } finally {
      restore();
    }
  });

  it("on macOS lets an explicit serviceLabel skip the brew probe", async () => {
    const restore = spoofPlatform("darwin");
    try {
      const uid = process.getuid?.() ?? 0;
      execFileMock.mockResolvedValue({ stdout: "ok", stderr: "" });
      await restartService({ serviceLabel: "com.explicit.label" });
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith("launchctl", [
        "kickstart",
        "-k",
        `gui/${uid}/com.explicit.label`,
      ]);
    } finally {
      restore();
    }
  });

  it("honors THREADBASE_SYSTEMD_UNIT env var on Linux", async () => {
    const restore = spoofPlatform("linux");
    try {
      process.env.THREADBASE_SYSTEMD_UNIT = "custom.service";
      execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
      await restartService();
      expect(execFileMock).toHaveBeenCalledWith("systemctl", [
        "--user",
        "restart",
        "custom.service",
      ]);
    } finally {
      restore();
    }
  });

  it("honors explicit serviceLabel option", async () => {
    const restore = spoofPlatform("linux");
    try {
      execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
      await restartService({ serviceLabel: "override.service" });
      expect(execFileMock).toHaveBeenCalledWith("systemctl", [
        "--user",
        "restart",
        "override.service",
      ]);
    } finally {
      restore();
    }
  });

  it("returns method=none on an unsupported platform", async () => {
    const restore = spoofPlatform("aix" as NodeJS.Platform);
    try {
      const r = await restartService();
      expect(r.method).toBe("none");
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("propagates execFile failures so the caller can surface them", async () => {
    const restore = spoofPlatform("linux");
    try {
      execFileMock.mockRejectedValueOnce(new Error("systemctl: unit not found"));
      await expect(restartService()).rejects.toThrow(/unit not found/);
    } finally {
      restore();
    }
  });
});

describe("stopService", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("is a no-op on macOS", async () => {
    const restore = spoofPlatform("darwin");
    try {
      const r = await stopService();
      expect(r.method).toBe("noop");
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("is a no-op on Linux", async () => {
    const restore = spoofPlatform("linux");
    try {
      const r = await stopService();
      expect(r.method).toBe("noop");
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("on Windows runs schtasks /End", async () => {
    const restore = spoofPlatform("win32");
    try {
      execFileMock
        .mockResolvedValueOnce({ stdout: "ended", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" });
      const r = await stopService();
      expect(r.method).toBe("schtasks-end");
      expect(execFileMock).toHaveBeenNthCalledWith(1, "schtasks.exe", [
        "/End",
        "/TN",
        "Threadbase",
      ]);
      expect(execFileMock).toHaveBeenNthCalledWith(2, "netstat.exe", ["-ano", "-p", "tcp"]);
    } finally {
      restore();
    }
  });

  it("on Windows tolerates schtasks /End failing (task may already be stopped)", async () => {
    const restore = spoofPlatform("win32");
    try {
      execFileMock
        .mockRejectedValueOnce(new Error("task is not running"))
        .mockResolvedValueOnce({ stdout: "", stderr: "" });
      const r = await stopService();
      expect(r.method).toBe("schtasks-end");
      expect(r.stderr).toMatch(/task is not running/);
    } finally {
      restore();
    }
  });

  it("on Windows kills the process tree listening on the configured port", async () => {
    const restore = spoofPlatform("win32");
    try {
      execFileMock
        .mockResolvedValueOnce({ stdout: "ended", stderr: "" })
        .mockResolvedValueOnce({
          stdout:
            "  TCP    127.0.0.1:9999    0.0.0.0:0    LISTENING    1234\r\n" +
            "  TCP    [::1]:9999        [::]:0       LISTENING    1234\r\n" +
            "  TCP    127.0.0.1:8766    0.0.0.0:0    LISTENING    5678\r\n",
          stderr: "",
        })
        .mockResolvedValueOnce({ stdout: "SUCCESS", stderr: "" });

      await stopService({ port: 9999 });

      expect(execFileMock).toHaveBeenNthCalledWith(3, "taskkill.exe", ["/PID", "1234", "/T", "/F"]);
      expect(execFileMock).toHaveBeenCalledTimes(3);
    } finally {
      restore();
    }
  });
});
