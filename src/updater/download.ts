import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ReleaseAsset } from "./github-releases";
import { pickArtifact, type ReleaseManifest, ReleaseManifestSchema } from "./manifest";

const MANIFEST_FILENAME = "manifest.json";

/**
 * Locates manifest.json among a release's assets, downloads it, and validates
 * its schema. Throws if missing or malformed.
 */
export async function fetchManifest(assets: ReleaseAsset[]): Promise<ReleaseManifest> {
  const asset = assets.find((a) => a.name === MANIFEST_FILENAME);
  if (!asset) {
    throw new Error(
      `Release has no ${MANIFEST_FILENAME} asset. Available: ${assets.map((a) => a.name).join(", ") || "(none)"}`,
    );
  }
  const res = await fetch(asset.browserDownloadUrl, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to download manifest: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as unknown;
  return ReleaseManifestSchema.parse(raw);
}

/**
 * Streams a release tarball to `targetPath` and verifies its sha256 against
 * the manifest. On hash mismatch, the partial file is deleted and an error
 * is thrown.
 */
export async function downloadAndVerify(opts: {
  manifest: ReleaseManifest;
  assets: ReleaseAsset[];
  targetPath: string;
}): Promise<{ path: string; bytes: number }> {
  const { manifest, assets, targetPath } = opts;
  const artifact = pickArtifact(manifest);

  const asset = assets.find((a) => a.name === artifact.filename);
  if (!asset) {
    throw new Error(
      `Manifest references ${artifact.filename} but it is not attached to the release`,
    );
  }

  // Use dirname() rather than a "/"-only regex: on Windows targetPath is
  // backslash-separated, so a forward-slash strip is a no-op and mkdirSync
  // would create the target file itself as a directory.
  mkdirSync(dirname(targetPath), { recursive: true });

  const res = await fetch(asset.browserDownloadUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${artifact.filename}: ${res.status} ${res.statusText}`);
  }

  const hash = createHash("sha256");
  const out = createWriteStream(targetPath);
  let bytes = 0;

  const measured = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(res.body.pipeThrough(measured), out);
  } catch (err) {
    rmSync(targetPath, { force: true });
    throw err;
  }

  const actual = hash.digest("hex");
  if (actual !== artifact.sha256) {
    rmSync(targetPath, { force: true });
    throw new Error(
      `sha256 mismatch for ${artifact.filename}: expected ${artifact.sha256}, got ${actual}`,
    );
  }

  const stat = statSync(targetPath);
  if (stat.size !== artifact.size) {
    rmSync(targetPath, { force: true });
    throw new Error(
      `size mismatch for ${artifact.filename}: expected ${artifact.size}, got ${stat.size}`,
    );
  }

  return { path: targetPath, bytes };
}
