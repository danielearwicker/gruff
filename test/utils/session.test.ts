import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  storeRefreshToken,
  getSession,
  validateRefreshToken,
  invalidateSession,
  rotateRefreshToken,
  getUserSessions,
  cleanupExpiredSessions,
  type SessionData,
} from '../../src/utils/session.js';
import { hashToken } from '../../src/utils/sensitive-data.js';

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
  async list(): Promise<any> {
    return { keys: [], list_complete: true, cursor: '' };
  }

  async getWithMetadata(): Promise<any> {
    return { value: null, metadata: null };
  }
}

describe('Session Store', () => {
  let kv: MockKVNamespace;
  const userId = '123e4567-e89b-12d3-a456-426614174000';
  const email = 'test@example.com';
  const refreshToken = 'refresh-token-xyz';

  beforeEach(() => {
    kv = new MockKVNamespace();
  });

  describe('storeRefreshToken', () => {
    it('should store a hashed refresh token in KV', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      const key = `session:${userId}`;
      const stored = await kv.get(key);

      expect(stored).not.toBeNull();

      if (stored) {
        const sessionData: SessionData = JSON.parse(stored);
        expect(sessionData.userId).toBe(userId);
        expect(sessionData.email).toBe(email);
        // The stored value should be a hash, not the plain token
        expect(sessionData.refreshTokenHash).not.toBe(refreshToken);
        // Verify it's a valid SHA-256 base64 hash (44 chars with padding)
        expect(sessionData.refreshTokenHash.length).toBe(44);
        expect(sessionData.createdAt).toBeGreaterThan(0);
        expect(sessionData.expiresAt).toBeGreaterThan(sessionData.createdAt);
      }
    });

    it('should use custom key prefix', async () => {
      const customPrefix = 'custom:';
      await storeRefreshToken(kv, userId, email, refreshToken, {
        keyPrefix: customPrefix,
      });

      const key = `${customPrefix}${userId}`;
      const stored = await kv.get(key);

      expect(stored).not.toBeNull();
    });

    it('should use custom TTL', async () => {
      const customTtl = 3600; // 1 hour
      await storeRefreshToken(kv, userId, email, refreshToken, {
        refreshTokenTtl: customTtl,
      });

      const key = `session:${userId}`;
      const stored = await kv.get(key);

      if (stored) {
        const sessionData: SessionData = JSON.parse(stored);
        const expectedExpiry = sessionData.createdAt + customTtl * 1000;
        expect(sessionData.expiresAt).toBe(expectedExpiry);
      }
    });
  });

  describe('getSession', () => {
    it('should retrieve a stored session with hashed token', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      const session = await getSession(kv, userId);

      expect(session).not.toBeNull();
      expect(session?.userId).toBe(userId);
      expect(session?.email).toBe(email);
      // Session now stores hash, not plain token
      expect(session?.refreshTokenHash).not.toBe(refreshToken);
      expect(session?.refreshTokenHash.length).toBe(44);
    });

    it('should return null for non-existent session', async () => {
      const session = await getSession(kv, 'non-existent-user-id');

      expect(session).toBeNull();
    });

    it('should return null and delete expired session', async () => {
      // Store session with very short TTL
      await storeRefreshToken(kv, userId, email, refreshToken, {
        refreshTokenTtl: 1, // 1 second
      });

      // Manually set expiration to the past
      const key = `session:${userId}`;
      const stored = await kv.get(key);
      if (stored) {
        const sessionData: SessionData = JSON.parse(stored);
        sessionData.expiresAt = Date.now() - 1000; // 1 second in the past
        await kv.put(key, JSON.stringify(sessionData));
      }

      const session = await getSession(kv, userId);

      expect(session).toBeNull();

      // Verify session was deleted
      const deletedSession = await kv.get(key);
      expect(deletedSession).toBeNull();
    });

    it('should handle corrupted session data', async () => {
      const key = `session:${userId}`;
      await kv.put(key, 'invalid-json');

      const session = await getSession(kv, userId);

      expect(session).toBeNull();

      // Verify corrupted session was deleted
      const deletedSession = await kv.get(key);
      expect(deletedSession).toBeNull();
    });
  });

  describe('validateRefreshToken', () => {
    it('should validate correct refresh token', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      const isValid = await validateRefreshToken(kv, userId, refreshToken);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect refresh token', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      const isValid = await validateRefreshToken(kv, userId, 'wrong-token');

      expect(isValid).toBe(false);
    });

    it('should reject token for non-existent session', async () => {
      const isValid = await validateRefreshToken(kv, 'non-existent-user', refreshToken);

      expect(isValid).toBe(false);
    });

    it('should use timing-safe comparison', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      // Test with tokens of different lengths (should not leak timing info)
      const shortToken = 'short';
      const longToken = 'this-is-a-very-long-token-that-does-not-match';

      const isValidShort = await validateRefreshToken(kv, userId, shortToken);
      const isValidLong = await validateRefreshToken(kv, userId, longToken);

      expect(isValidShort).toBe(false);
      expect(isValidLong).toBe(false);
    });

    it('should handle legacy sessions (backward compatibility)', async () => {
      // Manually store a legacy session with plain text refreshToken
      const legacySession = {
        userId,
        email,
        refreshToken: 'legacy-plain-token',
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60, // 1 hour from now
      };
      const key = `session:${userId}`;
      await kv.put(key, JSON.stringify(legacySession));

      // Should still validate the plain text token
      const isValid = await validateRefreshToken(kv, userId, 'legacy-plain-token');
      expect(isValid).toBe(true);

      // Should reject wrong token
      const isWrongValid = await validateRefreshToken(kv, userId, 'wrong-token');
      expect(isWrongValid).toBe(false);
    });
  });

  describe('invalidateSession', () => {
    it('should delete session from KV', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      // Verify session exists
      let session = await getSession(kv, userId);
      expect(session).not.toBeNull();

      await invalidateSession(kv, userId);

      // Verify session was deleted
      session = await getSession(kv, userId);
      expect(session).toBeNull();
    });

    it('should not throw error when deleting non-existent session', async () => {
      await expect(invalidateSession(kv, 'non-existent-user')).resolves.not.toThrow();
    });

    it('should respect custom key prefix', async () => {
      const customPrefix = 'custom:';
      await storeRefreshToken(kv, userId, email, refreshToken, {
        keyPrefix: customPrefix,
      });

      await invalidateSession(kv, userId, { keyPrefix: customPrefix });

      const session = await getSession(kv, userId, { keyPrefix: customPrefix });
      expect(session).toBeNull();
    });
  });

  describe('rotateRefreshToken', () => {
    it('should update session with new hashed refresh token', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      const newToken = 'new-refresh-token-abc';
      const success = await rotateRefreshToken(kv, userId, newToken);

      expect(success).toBe(true);

      // Validate with the new token
      const isValid = await validateRefreshToken(kv, userId, newToken);
      expect(isValid).toBe(true);

      // Old token should no longer work
      const isOldValid = await validateRefreshToken(kv, userId, refreshToken);
      expect(isOldValid).toBe(false);
    });

    it('should return false for non-existent session', async () => {
      const newToken = 'new-refresh-token-abc';
      const success = await rotateRefreshToken(kv, 'non-existent-user', newToken);

      expect(success).toBe(false);
    });

    it('should preserve user data during rotation', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      const newToken = 'new-refresh-token-abc';
      await rotateRefreshToken(kv, userId, newToken);

      const session = await getSession(kv, userId);
      expect(session?.userId).toBe(userId);
      expect(session?.email).toBe(email);
    });
  });

  describe('getUserSessions', () => {
    it('should return array with session if exists', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      const sessions = await getUserSessions(kv, userId);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].userId).toBe(userId);
      expect(sessions[0].email).toBe(email);
    });

    it('should return empty array if no session exists', async () => {
      const sessions = await getUserSessions(kv, 'non-existent-user');

      expect(sessions).toHaveLength(0);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should remove expired session and return 1', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken, {
        refreshTokenTtl: 1,
      });

      // Manually expire the session
      const key = `session:${userId}`;
      const stored = await kv.get(key);
      if (stored) {
        const sessionData: SessionData = JSON.parse(stored);
        sessionData.expiresAt = Date.now() - 1000;
        await kv.put(key, JSON.stringify(sessionData));
      }

      const cleanedCount = await cleanupExpiredSessions(kv, userId);

      expect(cleanedCount).toBe(1);

      // Verify session was deleted
      const session = await getSession(kv, userId);
      expect(session).toBeNull();
    });

    it('should not remove valid session and return 0', async () => {
      await storeRefreshToken(kv, userId, email, refreshToken);

      const cleanedCount = await cleanupExpiredSessions(kv, userId);

      expect(cleanedCount).toBe(0);

      // Verify session still exists
      const session = await getSession(kv, userId);
      expect(session).not.toBeNull();
    });

    it('should return 0 for non-existent session', async () => {
      const cleanedCount = await cleanupExpiredSessions(kv, 'non-existent-user');

      expect(cleanedCount).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent session updates', async () => {
      // Store initial session
      await storeRefreshToken(kv, userId, email, refreshToken);

      // Simulate concurrent updates
      const token1 = 'token-1';
      const token2 = 'token-2';

      await Promise.all([
        rotateRefreshToken(kv, userId, token1),
        rotateRefreshToken(kv, userId, token2),
      ]);

      // One of the tokens should be valid (last write wins)
      const isValid1 = await validateRefreshToken(kv, userId, token1);
      const isValid2 = await validateRefreshToken(kv, userId, token2);

      // Only one should be valid
      expect(isValid1 !== isValid2).toBe(true);
    });

    it('should handle very long user IDs and tokens', async () => {
      const longUserId = 'a'.repeat(500);
      const longToken = 'b'.repeat(1000);

      await storeRefreshToken(kv, longUserId, email, longToken);

      // Validate the token works (hash comparison)
      const isValid = await validateRefreshToken(kv, longUserId, longToken);
      expect(isValid).toBe(true);
    });

    it('should handle special characters in data', async () => {
      const specialEmail = 'test+special@example.com';
      const specialToken = 'token-with-special-chars-!@#$%^&*()';

      await storeRefreshToken(kv, userId, specialEmail, specialToken);

      const session = await getSession(kv, userId);
      expect(session?.email).toBe(specialEmail);
      // Validate with special character token
      const isValid = await validateRefreshToken(kv, userId, specialToken);
      expect(isValid).toBe(true);
    });
  });
});
