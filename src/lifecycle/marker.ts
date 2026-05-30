import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "../logger";
import { markerPath } from "./constants";
import { type Marker, MarkerSchema } from "./marker-schema";

const log = getLogger("lifecycle.marker");

export function readMarker(): Marker | null {
  if (!existsSync(markerPath())) return null;
  try {
    const raw = readFileSync(markerPath(), "utf8");
    const parsed = JSON.parse(raw);
    return MarkerSchema.parse(parsed);
  } catch (err) {
    log.warn(`marker at ${markerPath()} is malformed; treating as absent`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function writeMarker(marker: Marker): void {
  MarkerSchema.parse(marker);
  mkdirSync(dirname(markerPath()), { recursive: true });
  const tmp = `${markerPath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, markerPath());
}

export function clearMarker(): void {
  if (existsSync(markerPath())) rmSync(markerPath());
}
