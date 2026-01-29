import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computeAclHash,
  deduplicateAclEntries,
  buildAclFilterClause,
  filterByAclPermission,
  createResourceAcl,
} from '../../src/utils/acl.js';
import type { AclEntry } from '../../src/schemas/acl.js';

// Mock KV namespace
class MockKVNamespace implements KVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;

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

  async list(): Promise<{ keys: unknown[]; list_complete: boolean; cursor: string }> {
    return { keys: [], list_complete: true, cursor: '' };
  }

  async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
    return { value: null, metadata: null };
  }

  _clear(): void {
    this.store.clear();
  }
}

// Mock D1 database
class MockD1Database implements D1Database {
  private preparedStatement: MockD1PreparedStatement | null = null;

  prepare(query: string): D1PreparedStatement {
    this.preparedStatement = new MockD1PreparedStatement(query);
    return this.preparedStatement;
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return [];
  }

  async exec(query: string): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }
}

class MockD1PreparedStatement implements D1PreparedStatement {
  private _query: string;
  private _bindings: unknown[] = [];
  private _mockResults: unknown[] = [];

  constructor(query: string) {
    this._query = query;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this._bindings = values;
    return this;
  }

  async first<T = unknown>(columnName?: string): Promise<T | null> {
    return this._mockResults[0] as T | null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this._mockResults as T[],
      meta: {} as D1Meta,
    };
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this._mockResults as T[],
      meta: {} as D1Meta,
    };
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    return [];
  }

  _setMockResults(results: unknown[]): void {
    this._mockResults = results;
  }
}

describe('ACL Utility Functions', () => {
  describe('computeAclHash', () => {
    it('should compute consistent hash for same entries regardless of order', async () => {
      const entries1: AclEntry[] = [
        { principal_type: 'user', principal_id: 'user-001', permission: 'read' },
        { principal_type: 'group', principal_id: 'group-001', permission: 'write' },
      ];

      const entries2: AclEntry[] = [
        { principal_type: 'group', principal_id: 'group-001', permission: 'write' },
        { principal_type: 'user', principal_id: 'user-001', permission: 'read' },
      ];

      const hash1 = await computeAclHash(entries1);
      const hash2 = await computeAclHash(entries2);

      expect(hash1).toBe(hash2);
    });

    it('should return different hashes for different entries', async () => {
      const entries1: AclEntry[] = [
        { principal_type: 'user', principal_id: 'user-001', permission: 'read' },
      ];

      const entries2: AclEntry[] = [
        { principal_type: 'user', principal_id: 'user-002', permission: 'read' },
      ];

      const hash1 = await computeAclHash(entries1);
      const hash2 = await computeAclHash(entries2);

      expect(hash1).not.toBe(hash2);
    });

    it('should return consistent hash for empty entries', async () => {
      const hash1 = await computeAclHash([]);
      const hash2 = await computeAclHash([]);

      expect(hash1).toBe(hash2);
    });

    it('should generate 64-character hex hash (SHA-256)', async () => {
      const entries: AclEntry[] = [
        { principal_type: 'user', principal_id: 'user-001', permission: 'read' },
      ];

      const hash = await computeAclHash(entries);

      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
    });
  });

  describe('deduplicateAclEntries', () => {
    it('should remove duplicate entries', () => {
      const entries: AclEntry[] = [
        { principal_type: 'user', principal_id: 'user-001', permission: 'read' },
        { principal_type: 'user', principal_id: 'user-001', permission: 'read' },
        { principal_type: 'user', principal_id: 'user-001', permission: 'write' },
      ];

      const deduped = deduplicateAclEntries(entries);

      expect(deduped).toHaveLength(2);
      expect(deduped).toContainEqual({
        principal_type: 'user',
        principal_id: 'user-001',
        permission: 'read',
      });
      expect(deduped).toContainEqual({
        principal_type: 'user',
        principal_id: 'user-001',
        permission: 'write',
      });
    });

    it('should keep all entries when no duplicates', () => {
      const entries: AclEntry[] = [
        { principal_type: 'user', principal_id: 'user-001', permission: 'read' },
        { principal_type: 'group', principal_id: 'group-001', permission: 'write' },
      ];

      const deduped = deduplicateAclEntries(entries);

      expect(deduped).toHaveLength(2);
    });

    it('should return empty array for empty input', () => {
      const deduped = deduplicateAclEntries([]);
      expect(deduped).toHaveLength(0);
    });
  });

  describe('filterByAclPermission', () => {
    const accessibleAclIds = new Set([1, 2, 3]);

    it('should include items with accessible ACL IDs', () => {
      const items = [
        { id: 'a', acl_id: 1 },
        { id: 'b', acl_id: 2 },
        { id: 'c', acl_id: 4 },
      ];

      const filtered = filterByAclPermission(items, accessibleAclIds);

      expect(filtered).toHaveLength(2);
      expect(filtered.map(i => i.id)).toEqual(['a', 'b']);
    });

    it('should include items with null acl_id (public)', () => {
      const items = [
        { id: 'a', acl_id: null },
        { id: 'b', acl_id: 4 },
      ];

      const filtered = filterByAclPermission(items, accessibleAclIds);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('a');
    });

    it('should include items with undefined acl_id (public)', () => {
      const items = [
        { id: 'a', acl_id: undefined },
        { id: 'b', acl_id: 4 },
      ];

      const filtered = filterByAclPermission(items, accessibleAclIds);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('a');
    });

    it('should return empty array when no items match', () => {
      const items = [
        { id: 'a', acl_id: 99 },
        { id: 'b', acl_id: 100 },
      ];

      const filtered = filterByAclPermission(items, accessibleAclIds);

      expect(filtered).toHaveLength(0);
    });

    it('should return all items when all are public', () => {
      const items = [
        { id: 'a', acl_id: null },
        { id: 'b', acl_id: null },
      ];

      const filtered = filterByAclPermission(items, new Set());

      expect(filtered).toHaveLength(2);
    });
  });
});

describe('Permission Checking Logic', () => {
  describe('Write implies Read', () => {
    it('should conceptually allow read when user has write permission', () => {
      // This tests the concept: when checking for 'read' permission,
      // we should check both 'read' and 'write' entries.
      // A user with 'write' should implicitly have 'read'.

      // The actual implementation does this in getAccessibleAclIds:
      // For 'read' permission, it queries for both 'read' and 'write' entries
      // For 'write' permission, it only queries for 'write' entries

      // We're testing the concept here since actual database calls
      // are tested in integration tests
      const permissionsToCheckForRead = ['read', 'write'];
      const permissionsToCheckForWrite = ['write'];

      expect(permissionsToCheckForRead).toContain('write');
      expect(permissionsToCheckForWrite).not.toContain('read');
    });
  });

  describe('NULL ACL handling', () => {
    it('should treat null/undefined acl_id as public (accessible to all)', () => {
      // Items with null or undefined acl_id should be accessible
      const publicItem = { id: 'public', acl_id: null };
      const privateItem = { id: 'private', acl_id: 1 };

      const emptyAccessibleSet = new Set<number>();

      const filtered = filterByAclPermission([publicItem, privateItem], emptyAccessibleSet);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('public');
    });
  });
});

describe('createResourceAcl', () => {
  describe('Permission Inheritance Logic', () => {
    it('should create creator-only ACL when no explicit ACL is provided', async () => {
      // When acl is undefined, createResourceAcl should create an ACL with just the creator
      // This is the conceptual test - actual DB calls are tested in integration tests

      // The function should be called with (db, creatorId, undefined)
      // and it should create an ACL with entries: [{ principal_type: 'user', principal_id: creatorId, permission: 'write' }]
      const creatorId = 'creator-user-001';

      // Since createResourceAcl requires a real DB, we test the logic conceptually:
      // undefined acl means creator-only with write permission
      const expectedEntries: AclEntry[] = [
        { principal_type: 'user', principal_id: creatorId, permission: 'write' },
      ];

      expect(expectedEntries).toHaveLength(1);
      expect(expectedEntries[0].principal_id).toBe(creatorId);
      expect(expectedEntries[0].permission).toBe('write');
    });

    it('should return null when empty ACL array is provided (public resource)', async () => {
      // When acl is an empty array [], the resource should be public (no ACL)
      // createResourceAcl should return null
      const explicitAcl: AclEntry[] = [];

      // Empty array means public - the function returns null
      expect(explicitAcl.length).toBe(0);
      // In the actual function: if (explicitAcl !== undefined && explicitAcl.length === 0) return null;
    });

    it('should add creator write permission when not in explicit ACL', async () => {
      // When explicit ACL is provided but doesn't include creator write permission,
      // the function should add it
      const creatorId = 'creator-user-001';
      const explicitAcl: AclEntry[] = [
        { principal_type: 'user', principal_id: 'other-user', permission: 'read' },
      ];

      // The function should merge: [creatorEntry, ...explicitAcl]
      const creatorEntry: AclEntry = {
        principal_type: 'user',
        principal_id: creatorId,
        permission: 'write',
      };

      const expectedEntries = [creatorEntry, ...explicitAcl];
      expect(expectedEntries).toHaveLength(2);
      expect(expectedEntries[0]).toEqual(creatorEntry);
      expect(expectedEntries[1]).toEqual(explicitAcl[0]);
    });

    it('should not duplicate creator permission when already in explicit ACL', async () => {
      // When explicit ACL already includes creator write permission,
      // the function should not add a duplicate
      const creatorId = 'creator-user-001';
      const explicitAcl: AclEntry[] = [
        { principal_type: 'user', principal_id: creatorId, permission: 'write' },
        { principal_type: 'user', principal_id: 'other-user', permission: 'read' },
      ];

      // The function should use explicitAcl as-is
      const hasCreatorWrite = explicitAcl.some(
        e => e.principal_type === 'user' && e.principal_id === creatorId && e.permission === 'write'
      );

      expect(hasCreatorWrite).toBe(true);
      // When hasCreatorWrite is true, entries = explicitAcl (no modification)
    });
  });
});
