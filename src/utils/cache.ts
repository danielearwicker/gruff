/**
 * KV-based caching utility for frequently accessed data
 *
 * This module provides a caching layer using Cloudflare KV for:
 * - Types (frequently accessed, rarely changes)
 * - Individual entity lookups
 * - Other read-heavy endpoints
 *
 * Features:
 * - Configurable TTL per data type
 * - Cache invalidation on write operations
 * - Stale-while-revalidate pattern support
 * - Cache key namespacing to avoid collisions
 */

/**
 * Cache categories with their default TTLs (in seconds)
 */
export const CACHE_TTL = {
  /** Types are rarely modified, cache for 5 minutes */
  TYPES: 300,
  /** Types list can be cached longer since it changes infrequently */
  TYPES_LIST: 300,
  /** Individual entities change more frequently, cache for 1 minute */
  ENTITY: 60,
  /** Links are similar to entities */
  LINK: 60,
  /** User data is moderately stable */
  USER: 120,
  /** Short TTL for dynamic data */
  SHORT: 30,
  /** Default TTL for unspecified types */
  DEFAULT: 60,
} as const;

/**
 * Cache key prefixes for different data types
 */
export const CACHE_PREFIX = {
  TYPE: 'cache:type:',
  TYPES_LIST: 'cache:types:list:',
  ENTITY: 'cache:entity:',
  LINK: 'cache:link:',
  USER: 'cache:user:',
} as const;

/**
 * Cache configuration options
 */
export interface CacheConfig {
  /** TTL in seconds (overrides default for the cache type) */
  ttl?: number;
  /** Custom key prefix */
  prefix?: string;
  /** Whether to skip caching (useful for authenticated requests with user-specific data) */
  skipCache?: boolean;
}

/**
 * Cached data wrapper with metadata
 */
export interface CachedData<T> {
  /** The cached data */
  data: T;
  /** Timestamp when the data was cached (Unix ms) */
  cachedAt: number;
  /** TTL in seconds */
  ttl: number;
  /** Cache version for potential future invalidation patterns */
  version: number;
}

/** Current cache version - increment to invalidate all caches */
const CACHE_VERSION = 1;

/**
 * Generate a cache key for a type by ID
 */
export function getTypeCacheKey(typeId: string): string {
  return `${CACHE_PREFIX.TYPE}${typeId}`;
}

/**
 * Generate a cache key for the types list
 * Includes filter parameters to ensure correct cache hits
 */
export function getTypesListCacheKey(category?: string, name?: string): string {
  const params = [];
  if (category) params.push(`cat=${category}`);
  if (name) params.push(`name=${name}`);
  return `${CACHE_PREFIX.TYPES_LIST}${params.length > 0 ? params.join('&') : 'all'}`;
}

/**
 * Generate a cache key for an entity by ID
 */
export function getEntityCacheKey(entityId: string): string {
  return `${CACHE_PREFIX.ENTITY}${entityId}`;
}

/**
 * Generate a cache key for a link by ID
 */
export function getLinkCacheKey(linkId: string): string {
  return `${CACHE_PREFIX.LINK}${linkId}`;
}

/**
 * Generate a cache key for a user by ID
 */
export function getUserCacheKey(userId: string): string {
  return `${CACHE_PREFIX.USER}${userId}`;
}

/**
 * Store data in the cache
 *
 * @param kv - KV namespace binding
 * @param key - Cache key
 * @param data - Data to cache
 * @param ttl - TTL in seconds (defaults to CACHE_TTL.DEFAULT)
 */
export async function setCache<T>(
  kv: KVNamespace,
  key: string,
  data: T,
  ttl: number = CACHE_TTL.DEFAULT
): Promise<void> {
  const cachedData: CachedData<T> = {
    data,
    cachedAt: Date.now(),
    ttl,
    version: CACHE_VERSION,
  };

  await kv.put(key, JSON.stringify(cachedData), {
    expirationTtl: ttl,
  });
}

/**
 * Retrieve data from the cache
 *
 * @param kv - KV namespace binding
 * @param key - Cache key
 * @returns Cached data if found and valid, null otherwise
 */
export async function getCache<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const value = await kv.get(key);

  if (!value) {
    return null;
  }

  try {
    const cached = JSON.parse(value) as CachedData<T>;

    // Check cache version for invalidation
    if (cached.version !== CACHE_VERSION) {
      // Old cache version, delete and return null
      await kv.delete(key);
      return null;
    }

    // Double-check expiration (KV TTL should handle this, but be safe)
    const age = Date.now() - cached.cachedAt;
    if (age > cached.ttl * 1000) {
      await kv.delete(key);
      return null;
    }

    return cached.data;
  } catch {
    // Invalid JSON, delete the corrupted cache entry
    await kv.delete(key);
    return null;
  }
}

/**
 * Delete a specific cache entry
 *
 * @param kv - KV namespace binding
 * @param key - Cache key to delete
 */
export async function deleteCache(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}

/**
 * Delete multiple cache entries by keys
 *
 * @param kv - KV namespace binding
 * @param keys - Array of cache keys to delete
 */
export async function deleteCacheMultiple(kv: KVNamespace, keys: string[]): Promise<void> {
  await Promise.all(keys.map(key => kv.delete(key)));
}

/**
 * Invalidate type cache
 * Call this when a type is created, updated, or deleted
 *
 * @param kv - KV namespace binding
 * @param typeId - Type ID to invalidate
 */
export async function invalidateTypeCache(kv: KVNamespace, typeId: string): Promise<void> {
  // Delete the specific type cache
  await deleteCache(kv, getTypeCacheKey(typeId));

  // Also invalidate the types list cache
  // Note: We can't easily enumerate all list cache keys, so we use a known pattern
  // In a more sophisticated implementation, you might use cache tags or versioning
  await invalidateTypesListCache(kv);
}

/**
 * Invalidate all types list caches
 * Since we can't enumerate KV keys efficiently, we use a version approach:
 * Store a version number and check it when reading list caches
 *
 * @param kv - KV namespace binding
 */
export async function invalidateTypesListCache(kv: KVNamespace): Promise<void> {
  // Increment the types list version to invalidate all list caches
  const versionKey = 'cache:types:version';
  const currentVersion = await kv.get(versionKey);
  const newVersion = (parseInt(currentVersion || '0', 10) + 1).toString();
  await kv.put(versionKey, newVersion, { expirationTtl: CACHE_TTL.TYPES_LIST * 10 });
}

/**
 * Get the current types list cache version
 */
export async function getTypesListVersion(kv: KVNamespace): Promise<string> {
  const version = await kv.get('cache:types:version');
  return version || '0';
}

/**
 * Generate a versioned types list cache key
 */
export async function getVersionedTypesListCacheKey(
  kv: KVNamespace,
  category?: string,
  name?: string
): Promise<string> {
  const version = await getTypesListVersion(kv);
  const baseKey = getTypesListCacheKey(category, name);
  return `${baseKey}:v${version}`;
}

/**
 * Invalidate entity cache
 * Call this when an entity is created, updated, deleted, or restored
 *
 * @param kv - KV namespace binding
 * @param entityId - Entity ID to invalidate
 */
export async function invalidateEntityCache(kv: KVNamespace, entityId: string): Promise<void> {
  await deleteCache(kv, getEntityCacheKey(entityId));
}

/**
 * Invalidate link cache
 * Call this when a link is created, updated, deleted, or restored
 *
 * @param kv - KV namespace binding
 * @param linkId - Link ID to invalidate
 */
export async function invalidateLinkCache(kv: KVNamespace, linkId: string): Promise<void> {
  await deleteCache(kv, getLinkCacheKey(linkId));
}

/**
 * Invalidate user cache
 *
 * @param kv - KV namespace binding
 * @param userId - User ID to invalidate
 */
export async function invalidateUserCache(kv: KVNamespace, userId: string): Promise<void> {
  await deleteCache(kv, getUserCacheKey(userId));
}

/**
 * Helper for cache-aside pattern: get from cache or fetch and cache
 *
 * @param kv - KV namespace binding
 * @param key - Cache key
 * @param fetcher - Function to fetch data if not cached
 * @param ttl - TTL in seconds
 * @param config - Additional cache configuration
 * @returns The data (from cache or freshly fetched)
 */
export async function getOrSet<T>(
  kv: KVNamespace,
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = CACHE_TTL.DEFAULT,
  config?: CacheConfig
): Promise<T> {
  // Skip cache if configured
  if (config?.skipCache) {
    return fetcher();
  }

  // Try to get from cache first
  const cached = await getCache<T>(kv, key);
  if (cached !== null) {
    return cached;
  }

  // Fetch fresh data
  const data = await fetcher();

  // Store in cache (don't await to avoid blocking the response)
  setCache(kv, key, data, config?.ttl ?? ttl).catch(() => {
    // Silently ignore cache write errors - they shouldn't break the request
  });

  return data;
}

/**
 * Cache statistics for monitoring (when needed)
 */
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
}

/**
 * Simple in-memory stats tracker for the current request
 * Note: This is per-request only; for persistent stats, use Analytics Engine
 */
export class CacheStatsTracker {
  private hits = 0;
  private misses = 0;

  recordHit(): void {
    this.hits++;
  }

  recordMiss(): void {
    this.misses++;
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}
