import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setCache,
  getCache,
  deleteCache,
  deleteCacheMultiple,
  getTypeCacheKey,
  getTypesListCacheKey,
  getEntityCacheKey,
  getLinkCacheKey,
  getUserCacheKey,
  getVersionedTypesListCacheKey,
  invalidateTypeCache,
  invalidateTypesListCache,
  invalidateEntityCache,
  invalidateLinkCache,
  invalidateUserCache,
  getOrSet,
  CACHE_TTL,
  CACHE_PREFIX,
  CacheStatsTracker,
} from '../../src/utils/cache.js';

// Mock KV namespace
class MockKVNamespace implements KVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;

    // Check if expired
    if (item.expiration && item.expiration < Date.now()) {
      this.store.delete(key);
      return null;
    }

    return item.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number }
  ): Promise<void> {
    const expiration = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options?.expiration;

    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // Other KVNamespace methods (not used in tests, but required by interface)
  async list(): Promise<{ keys: unknown[]; list_complete: boolean; cursor: string }> {
    return { keys: [], list_complete: true, cursor: '' };
  }

  async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
    return { value: null, metadata: null };
  }

  // Helper for testing
  _has(key: string): boolean {
    return this.store.has(key);
  }

  _clear(): void {
    this.store.clear();
  }
}

describe('Cache Utility', () => {
  let kv: MockKVNamespace;

  beforeEach(() => {
    kv = new MockKVNamespace();
  });

  describe('Cache Key Generation', () => {
    it('should generate correct type cache key', () => {
      const key = getTypeCacheKey('type-123');
      expect(key).toBe('cache:type:type-123');
    });

    it('should generate correct types list cache key without filters', () => {
      const key = getTypesListCacheKey();
      expect(key).toBe('cache:types:list:all');
    });

    it('should generate correct types list cache key with category', () => {
      const key = getTypesListCacheKey('entity');
      expect(key).toBe('cache:types:list:cat=entity');
    });

    it('should generate correct types list cache key with category and name', () => {
      const key = getTypesListCacheKey('entity', 'Person');
      expect(key).toBe('cache:types:list:cat=entity&name=Person');
    });

    it('should generate correct entity cache key', () => {
      const key = getEntityCacheKey('entity-456');
      expect(key).toBe('cache:entity:entity-456');
    });

    it('should generate correct link cache key', () => {
      const key = getLinkCacheKey('link-789');
      expect(key).toBe('cache:link:link-789');
    });

    it('should generate correct user cache key', () => {
      const key = getUserCacheKey('user-001');
      expect(key).toBe('cache:user:user-001');
    });
  });

  describe('setCache and getCache', () => {
    it('should store and retrieve data from cache', async () => {
      const key = 'test:key';
      const data = { name: 'Test', value: 123 };

      await setCache(kv, key, data);
      const cached = await getCache<typeof data>(kv, key);

      expect(cached).toEqual(data);
    });

    it('should return null for non-existent keys', async () => {
      const cached = await getCache(kv, 'nonexistent:key');
      expect(cached).toBeNull();
    });

    it('should store with custom TTL', async () => {
      const key = 'test:ttl';
      const data = { test: true };

      await setCache(kv, key, data, 600);

      // Key should exist
      const cached = await getCache<typeof data>(kv, key);
      expect(cached).toEqual(data);
    });

    it('should handle complex data structures', async () => {
      const key = 'test:complex';
      const data = {
        array: [1, 2, 3],
        nested: { deep: { value: 'nested' } },
        nullValue: null,
        bool: true,
      };

      await setCache(kv, key, data);
      const cached = await getCache<typeof data>(kv, key);

      expect(cached).toEqual(data);
    });

    it('should return null for invalid JSON in cache', async () => {
      // Manually store invalid JSON
      await kv.put('test:invalid', 'not-json{');

      const cached = await getCache(kv, 'test:invalid');
      expect(cached).toBeNull();
    });
  });

  describe('deleteCache', () => {
    it('should delete a single cache entry', async () => {
      const key = 'test:delete';
      await setCache(kv, key, { data: 'test' });

      await deleteCache(kv, key);

      const cached = await getCache(kv, key);
      expect(cached).toBeNull();
    });
  });

  describe('deleteCacheMultiple', () => {
    it('should delete multiple cache entries', async () => {
      const keys = ['test:a', 'test:b', 'test:c'];

      // Store test data
      for (const key of keys) {
        await setCache(kv, key, { key });
      }

      await deleteCacheMultiple(kv, keys);

      // All should be deleted
      for (const key of keys) {
        const cached = await getCache(kv, key);
        expect(cached).toBeNull();
      }
    });
  });

  describe('Cache Invalidation', () => {
    it('should invalidate type cache', async () => {
      const typeId = 'type-123';
      const cacheKey = getTypeCacheKey(typeId);

      await setCache(kv, cacheKey, { id: typeId });

      await invalidateTypeCache(kv, typeId);

      const cached = await getCache(kv, cacheKey);
      expect(cached).toBeNull();
    });

    it('should invalidate types list cache by incrementing version', async () => {
      // Get initial version
      const version1 = await kv.get('cache:types:version');
      expect(version1).toBeNull();

      await invalidateTypesListCache(kv);

      const version2 = await kv.get('cache:types:version');
      expect(version2).toBe('1');

      await invalidateTypesListCache(kv);

      const version3 = await kv.get('cache:types:version');
      expect(version3).toBe('2');
    });

    it('should generate versioned types list cache key', async () => {
      // Initial version
      const key1 = await getVersionedTypesListCacheKey(kv, 'entity');
      expect(key1).toContain('v0');

      // After invalidation
      await invalidateTypesListCache(kv);
      const key2 = await getVersionedTypesListCacheKey(kv, 'entity');
      expect(key2).toContain('v1');
    });

    it('should invalidate entity cache', async () => {
      const entityId = 'entity-123';
      const cacheKey = getEntityCacheKey(entityId);

      await setCache(kv, cacheKey, { id: entityId });

      await invalidateEntityCache(kv, entityId);

      const cached = await getCache(kv, cacheKey);
      expect(cached).toBeNull();
    });

    it('should invalidate link cache', async () => {
      const linkId = 'link-456';
      const cacheKey = getLinkCacheKey(linkId);

      await setCache(kv, cacheKey, { id: linkId });

      await invalidateLinkCache(kv, linkId);

      const cached = await getCache(kv, cacheKey);
      expect(cached).toBeNull();
    });

    it('should invalidate user cache', async () => {
      const userId = 'user-789';
      const cacheKey = getUserCacheKey(userId);

      await setCache(kv, cacheKey, { id: userId });

      await invalidateUserCache(kv, userId);

      const cached = await getCache(kv, cacheKey);
      expect(cached).toBeNull();
    });
  });

  describe('getOrSet (Cache-Aside Pattern)', () => {
    it('should return cached data without calling fetcher', async () => {
      const key = 'test:getOrSet';
      const data = { cached: true };

      // Pre-populate cache
      await setCache(kv, key, data);

      const fetcher = vi.fn().mockResolvedValue({ cached: false });

      const result = await getOrSet(kv, key, fetcher);

      expect(result).toEqual(data);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('should call fetcher and cache result on cache miss', async () => {
      const key = 'test:getOrSet:miss';
      const fetchedData = { fetched: true };
      const fetcher = vi.fn().mockResolvedValue(fetchedData);

      const result = await getOrSet(kv, key, fetcher);

      expect(result).toEqual(fetchedData);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Data should now be cached
      // Wait a bit for the non-blocking cache write
      await new Promise(resolve => setTimeout(resolve, 10));
      const cached = await getCache(kv, key);
      expect(cached).toEqual(fetchedData);
    });

    it('should respect skipCache config option', async () => {
      const key = 'test:getOrSet:skip';
      const cachedData = { cached: true };
      const fetchedData = { fetched: true };

      await setCache(kv, key, cachedData);

      const fetcher = vi.fn().mockResolvedValue(fetchedData);

      const result = await getOrSet(kv, key, fetcher, CACHE_TTL.DEFAULT, {
        skipCache: true,
      });

      expect(result).toEqual(fetchedData);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('should use custom TTL from config', async () => {
      const key = 'test:getOrSet:ttl';
      const fetchedData = { data: 'test' };
      const fetcher = vi.fn().mockResolvedValue(fetchedData);

      await getOrSet(kv, key, fetcher, CACHE_TTL.DEFAULT, { ttl: 3600 });

      // Fetcher should have been called
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('CacheStatsTracker', () => {
    it('should track hits and misses', () => {
      const tracker = new CacheStatsTracker();

      tracker.recordHit();
      tracker.recordHit();
      tracker.recordMiss();

      const stats = tracker.getStats();

      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.667, 2);
    });

    it('should return 0 hit rate when no requests', () => {
      const tracker = new CacheStatsTracker();

      const stats = tracker.getStats();

      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('should calculate 100% hit rate when all hits', () => {
      const tracker = new CacheStatsTracker();

      tracker.recordHit();
      tracker.recordHit();
      tracker.recordHit();

      const stats = tracker.getStats();

      expect(stats.hitRate).toBe(1);
    });
  });

  describe('CACHE_TTL Constants', () => {
    it('should have appropriate TTL values', () => {
      expect(CACHE_TTL.TYPES).toBe(300); // 5 minutes
      expect(CACHE_TTL.TYPES_LIST).toBe(300); // 5 minutes
      expect(CACHE_TTL.ENTITY).toBe(60); // 1 minute
      expect(CACHE_TTL.LINK).toBe(60); // 1 minute
      expect(CACHE_TTL.USER).toBe(120); // 2 minutes
      expect(CACHE_TTL.SHORT).toBe(30); // 30 seconds
      expect(CACHE_TTL.DEFAULT).toBe(60); // 1 minute
    });
  });

  describe('CACHE_PREFIX Constants', () => {
    it('should have correct prefix values', () => {
      expect(CACHE_PREFIX.TYPE).toBe('cache:type:');
      expect(CACHE_PREFIX.TYPES_LIST).toBe('cache:types:list:');
      expect(CACHE_PREFIX.ENTITY).toBe('cache:entity:');
      expect(CACHE_PREFIX.LINK).toBe('cache:link:');
      expect(CACHE_PREFIX.USER).toBe('cache:user:');
    });
  });

  describe('Cache Version Handling', () => {
    it('should reject cached data with outdated version', async () => {
      const key = 'test:version';

      // Manually store data with old version
      const oldVersionData = {
        data: { test: true },
        cachedAt: Date.now(),
        ttl: 3600,
        version: 0, // Old version
      };
      await kv.put(key, JSON.stringify(oldVersionData));

      // getCache should return null due to version mismatch
      const cached = await getCache(kv, key);
      expect(cached).toBeNull();
    });
  });
});
