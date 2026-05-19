import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAndVerify, fetchManifest } from "../src/updater/download";
import type { ReleaseAsset } from "../src/updater/github-releases";
import type { ReleaseManifest } from "../src/updater/manifest";
import { platformKey } from "../src/updater/manifest";

const PAYLOAD = new Uint8Array(Array.from({ length: 512 }, (_, i) => i % 256));
const PAYLOAD_SHA256 = createHash("sha256").update(PAYLOAD).digest("hex");

function streamingResponse(body: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, statusText: "OK" });
}

function tarballAsset(filename: string): ReleaseAsset {
  return {
    name: filename,
    browserDownloadUrl: `https://example/${filename}`,
    size: PAYLOAD.byteLength,
  };
}

function manifestFor(sha256: string, size = PAYLOAD.byteLength): ReleaseManifest {
  return {
    version: "1.0.0",
    schemaVersion: 1,
    artifacts: {
      [platformKey()]: {
        filename: `threadbase-streamer-1.0.0-${platformKey()}.tgz`,
        sha256,
        size,
      },
    },
  };
}

describe("downloadAndVerify", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-dl-"));
    target = join(dir, "tarball.tgz");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("returns the path when sha256 and size match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse(PAYLOAD)),
    );
    const manifest = manifestFor(PAYLOAD_SHA256);
    const r = await downloadAndVerify({
      manifest,
      assets: [tarballAsset(manifest.artifacts[platformKey()].filename)],
      targetPath: target,
    });
    expect(r.path).toBe(target);
    expect(r.bytes).toBe(PAYLOAD.byteLength);
    expect(existsSync(target)).toBe(true);
  });

  it("throws on sha256 mismatch and deletes the partial file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse(PAYLOAD)),
    );
    const manifest = manifestFor("f".repeat(64));
    await expect(
      downloadAndVerify({
        manifest,
        assets: [tarballAsset(manifest.artifacts[platformKey()].filename)],
        targetPath: target,
      }),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(existsSync(target)).toBe(false);
  });

  it("throws on size mismatch and deletes the partial file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse(PAYLOAD)),
    );
    const manifest = manifestFor(PAYLOAD_SHA256, PAYLOAD.byteLength + 1);
    await expect(
      downloadAndVerify({
        manifest,
        assets: [tarballAsset(manifest.artifacts[platformKey()].filename)],
        targetPath: target,
      }),
    ).rejects.toThrow(/size mismatch/);
    expect(existsSync(target)).toBe(false);
  });

  it("throws when fetch returns non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(new Response(null, { status: 404, statusText: "Not Found" }) as Response),
      ),
    );
    const manifest = manifestFor(PAYLOAD_SHA256);
    await expect(
      downloadAndVerify({
        manifest,
        assets: [tarballAsset(manifest.artifacts[platformKey()].filename)],
        targetPath: target,
      }),
    ).rejects.toThrow(/Failed to download/);
  });

  it("throws when the manifest references an asset the release doesn't have", async () => {
    const manifest = manifestFor(PAYLOAD_SHA256);
    await expect(
      downloadAndVerify({
        manifest,
        assets: [],
        targetPath: target,
      }),
    ).rejects.toThrow(/not attached to the release/);
  });
});

describe("fetchManifest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads and validates a valid manifest", async () => {
    const valid = manifestFor(PAYLOAD_SHA256);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify(valid), {
            status: 200,
            statusText: "OK",
          }) as Response,
        ),
      ),
    );
    const r = await fetchManifest([
      { name: "manifest.json", browserDownloadUrl: "https://example/manifest.json", size: 0 },
    ]);
    expect(r.version).toBe("1.0.0");
  });

  it("throws when manifest.json is not in the release assets", async () => {
    await expect(
      fetchManifest([
        { name: "other.tgz", browserDownloadUrl: "https://example/other.tgz", size: 1 },
      ]),
    ).rejects.toThrow(/no manifest\.json asset/i);
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(new Response(null, { status: 502, statusText: "Bad Gateway" }) as Response),
      ),
    );
    await expect(
      fetchManifest([
        { name: "manifest.json", browserDownloadUrl: "https://example/manifest.json", size: 0 },
      ]),
    ).rejects.toThrow(/Failed to download manifest/);
  });

  it("throws on schema-invalid manifest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: "1.0.0",
              schemaVersion: 1,
              artifacts: { x: { filename: "y", sha256: "not-hex", size: 1 } },
            }),
            { status: 200 },
          ) as Response,
        ),
      ),
    );
    await expect(
      fetchManifest([
        { name: "manifest.json", browserDownloadUrl: "https://example/manifest.json", size: 0 },
      ]),
    ).rejects.toThrow();
  });
});
