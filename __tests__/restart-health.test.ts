import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForRestartHealth } from "../src/updater/restart-health";

describe("waitForRestartHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts the target version with build metadata", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, version: "1.2.3+abc123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await waitForRestartHealth({ port: 8766, expectedVersion: "1.2.3", timeoutMs: 50 });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8766/healthz", {
      signal: expect.any(AbortSignal),
    });
  });

  it("retries an old live version until the target process is serving", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, version: "1.2.2" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, version: "1.2.3" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await waitForRestartHealth({
      port: 8766,
      expectedVersion: "1.2.3",
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with the observed runtime version when drift persists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ok: true, version: "1.2.2" }), { status: 200 }),
      ),
    );

    await expect(
      waitForRestartHealth({
        port: 8766,
        expectedVersion: "1.2.3",
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/running version is 1\.2\.2, expected 1\.2\.3/);
  });
});
