import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn(() => ({ pid: 99999, unref: () => undefined }));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const loadUpdateConfigMock = vi.fn();
vi.mock("../src/config/update-config", () => ({
  loadUpdateConfig: () => loadUpdateConfigMock(),
  UPDATE_CONFIG_PATH: "/tmp/test-update.yaml",
}));

import { StreamerServer } from "../src/server";

const SECRET = "supersecret123";
const API_KEY = "tb_test_webhook";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("POST /api/__update", () => {
  let server: StreamerServer;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    spawnMock.mockClear();
    loadUpdateConfigMock.mockReset();
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
    });
    await server.listen(0);
    port = server.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns 404 when webhook_secret is unset", async () => {
    loadUpdateConfigMock.mockReturnValue({
      auto_update: false,
      channel: "stable",
      allow: ["patch", "minor"],
      poll_interval_minutes: 60,
      defer_if_active_sessions: true,
      github_repo: "owner/repo",
      webhook_secret: null,
    });
    const res = await fetch(`${baseUrl}/api/__update`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns 401 on invalid signature", async () => {
    loadUpdateConfigMock.mockReturnValue({
      auto_update: false,
      channel: "stable",
      allow: ["patch", "minor"],
      poll_interval_minutes: 60,
      defer_if_active_sessions: true,
      github_repo: "owner/repo",
      webhook_secret: SECRET,
    });
    const body = `{"event":"release","version":"1.2.3"}`;
    const res = await fetch(`${baseUrl}/api/__update`, {
      method: "POST",
      headers: { "X-Threadbase-Signature": sign(body, "wrong-secret") },
      body,
    });
    expect(res.status).toBe(401);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns 401 when signature header is missing", async () => {
    loadUpdateConfigMock.mockReturnValue({
      auto_update: false,
      channel: "stable",
      allow: ["patch", "minor"],
      poll_interval_minutes: 60,
      defer_if_active_sessions: true,
      github_repo: "owner/repo",
      webhook_secret: SECRET,
    });
    const res = await fetch(`${baseUrl}/api/__update`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns 202 and spawns the updater on valid signature", async () => {
    loadUpdateConfigMock.mockReturnValue({
      auto_update: true,
      channel: "stable",
      allow: ["patch", "minor"],
      poll_interval_minutes: 60,
      defer_if_active_sessions: true,
      github_repo: "owner/repo",
      webhook_secret: SECRET,
    });
    const body = `{"event":"release","version":"1.2.3"}`;
    const res = await fetch(`${baseUrl}/api/__update`, {
      method: "POST",
      headers: { "X-Threadbase-Signature": sign(body) },
      body,
    });
    expect(res.status).toBe(202);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [execPath, args] = spawnMock.mock.calls[0];
    expect(execPath).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining(["update", "--force"]));
  });

  it("skips Bearer auth (route is public when secret unset; HMAC when set)", async () => {
    // Confirms that /api/__update is in PUBLIC_POST_PATHS — the request gets
    // past auth.middleware without a Bearer token. The handler's own
    // signature check is what gates access.
    loadUpdateConfigMock.mockReturnValue({
      auto_update: false,
      channel: "stable",
      allow: ["patch", "minor"],
      poll_interval_minutes: 60,
      defer_if_active_sessions: true,
      github_repo: "owner/repo",
      webhook_secret: null,
    });
    const res = await fetch(`${baseUrl}/api/__update`, { method: "POST", body: "{}" });
    // 404 here means the auth middleware did NOT block — the handler responded.
    expect(res.status).toBe(404);
  });
});
