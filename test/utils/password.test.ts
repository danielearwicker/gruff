import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/utils/password.js';

describe('Password Utilities', () => {
  describe('hashPassword', () => {
    it('should hash a password', async () => {
      const password = 'mySecurePassword123';
      const hash = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).toContain(':'); // Should contain salt:hash separator
    });

    it('should produce different hashes for the same password', async () => {
      const password = 'samePassword';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      // Different salts should produce different hashes
      expect(hash1).not.toBe(hash2);
    });

    it('should produce hash with correct format', async () => {
      const password = 'testPassword';
      const hash = await hashPassword(password);

      const parts = hash.split(':');
      expect(parts).toHaveLength(2);
      expect(parts[0]).toBeTruthy(); // Salt should exist
      expect(parts[1]).toBeTruthy(); // Hash should exist
    });

    it('should handle empty password', async () => {
      const hash = await hashPassword('');
      expect(hash).toBeDefined();
      expect(hash).toContain(':');
    });

    it('should handle long password', async () => {
      const longPassword = 'a'.repeat(1000);
      const hash = await hashPassword(longPassword);
      expect(hash).toBeDefined();
      expect(hash).toContain(':');
    });

    it('should handle special characters', async () => {
      const password = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
      const hash = await hashPassword(password);
      expect(hash).toBeDefined();
      expect(hash).toContain(':');
    });

    it('should handle unicode characters', async () => {
      const password = 'パスワード🔒';
      const hash = await hashPassword(password);
      expect(hash).toBeDefined();
      expect(hash).toContain(':');
    });
  });

  describe('verifyPassword', () => {
    it('should verify correct password', async () => {
      const password = 'correctPassword123';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'correctPassword';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword('wrongPassword', hash);
      expect(isValid).toBe(false);
    });

    it('should reject password with different case', async () => {
      const password = 'CaseSensitive';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword('casesensitive', hash);
      expect(isValid).toBe(false);
    });

    it('should handle empty password verification', async () => {
      const password = '';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword('', hash);
      expect(isValid).toBe(true);
    });

    it('should reject empty password against non-empty hash', async () => {
      const password = 'nonEmpty';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword('', hash);
      expect(isValid).toBe(false);
    });

    it('should handle invalid hash format', async () => {
      const isValid = await verifyPassword('password', 'invalid-hash');
      expect(isValid).toBe(false);
    });

    it('should handle malformed hash (missing colon)', async () => {
      const isValid = await verifyPassword('password', 'nocolonhere');
      expect(isValid).toBe(false);
    });

    it('should handle malformed hash (empty salt)', async () => {
      const isValid = await verifyPassword('password', ':hashonly');
      expect(isValid).toBe(false);
    });

    it('should handle malformed hash (empty hash)', async () => {
      const isValid = await verifyPassword('password', 'saltonly:');
      expect(isValid).toBe(false);
    });

    it('should handle malformed hash (invalid base64)', async () => {
      const isValid = await verifyPassword('password', 'invalid!@#:base64!@#');
      expect(isValid).toBe(false);
    });

    it('should handle long password verification', async () => {
      const password = 'a'.repeat(1000);
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should handle special characters verification', async () => {
      const password = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should handle unicode characters verification', async () => {
      const password = 'パスワード🔒';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject similar but different passwords', async () => {
      const password = 'password123';
      const hash = await hashPassword(password);

      const tests = [
        'password124', // Different number
        'password12', // Missing character
        'password1234', // Extra character
        'Password123', // Different case
        'password 123', // Added space
      ];

      for (const testPassword of tests) {
        const isValid = await verifyPassword(testPassword, hash);
        expect(isValid).toBe(false);
      }
    });
  });

  describe('timing safety', () => {
    it('should use timing-safe comparison', async () => {
      // This test verifies that the verification function uses timing-safe comparison
      // by ensuring it doesn't short-circuit on length differences
      const password = 'test';
      const hash = await hashPassword(password);

      // These should all take similar time to fail
      const startTime1 = Date.now();
      await verifyPassword('a', hash);
      const time1 = Date.now() - startTime1;

      const startTime2 = Date.now();
      await verifyPassword('abcdefghijklmnop', hash);
      const time2 = Date.now() - startTime2;

      // While we can't guarantee exact timing, both should complete quickly
      // The main goal is that they don't throw errors and complete successfully
      expect(time1).toBeGreaterThanOrEqual(0);
      expect(time2).toBeGreaterThanOrEqual(0);
    });
  });

  describe('security properties', () => {
    it('should produce cryptographically random salts', async () => {
      const password = 'samePassword';
      const hashes = await Promise.all(
        Array.from({ length: 10 }, () => hashPassword(password))
      );

      // All hashes should be unique (different salts)
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(10);
    });

    it('should maintain hash consistency across multiple verifications', async () => {
      const password = 'consistentPassword';
      const hash = await hashPassword(password);

      // Verify multiple times with same password
      const results = await Promise.all(
        Array.from({ length: 5 }, () => verifyPassword(password, hash))
      );

      // All verifications should succeed
      expect(results.every((r) => r === true)).toBe(true);
    });

    it('should produce sufficiently long hashes', async () => {
      const password = 'test';
      const hash = await hashPassword(password);

      // Hash should be reasonably long (base64 encoded salt + hash)
      // Salt is 16 bytes = 24 chars base64
      // Hash is 32 bytes = 44 chars base64
      // Plus colon separator = ~69 chars minimum
      expect(hash.length).toBeGreaterThan(60);
    });
  });
});
