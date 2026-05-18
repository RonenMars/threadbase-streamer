import { z } from "zod";

export const ReleaseManifestSchema = z
  .object({
    version: z.string(),
    schemaVersion: z.number().int().positive(),
    generatedAt: z.string().optional(),
    artifacts: z.record(
      z.string(),
      z.object({
        filename: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    ),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function pickArtifact(manifest: ReleaseManifest): ReleaseManifest["artifacts"][string] {
  const key = platformKey();
  const artifact = manifest.artifacts[key];
  if (!artifact) {
    const available = Object.keys(manifest.artifacts).join(", ") || "(none)";
    throw new Error(
      `No artifact for ${key} in release ${manifest.version}. Available: ${available}`,
    );
  }
  return artifact;
}
