import type {
  CacheMetadataKey,
  CacheMetadataRepository,
} from "../../db/repositories/cacheMetadata.repository";

/**
 * Functional accessors over the cache_metadata table. Repositories give us
 * the SQL surface; these helpers give us the verbs the services use.
 */
export function getCacheMetadata(
  repo: CacheMetadataRepository,
  key: CacheMetadataKey,
): string | null {
  return repo.getCacheMetadata(key);
}

export function setCacheMetadata(
  repo: CacheMetadataRepository,
  key: CacheMetadataKey,
  value: string,
): void {
  repo.setCacheMetadata(key, value);
}
